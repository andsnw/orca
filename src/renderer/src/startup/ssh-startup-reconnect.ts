import type { SshConnectionState } from '../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { getActiveSidebarWorkspaceId } from '../../../shared/workspace-scope'

export const SSH_STARTUP_RECONNECT_CONCURRENCY = 3

export type SshStartupReconnectResult = {
  timedOut: boolean
}

export type SshStartupReconnectOutcome =
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'in-progress'
  | 'not-started-budget'
  | 'cancelled'

export type SshStartupReconnectBatchResult = {
  targetId: string
  outcome: SshStartupReconnectOutcome
}

type ScheduledReconnect = {
  targetId: string
  deadline: number
  signal: AbortSignal
  connect: () => Promise<SshConnectionState | null>
  publishState: (state: SshConnectionState) => void
  onFailure: (error: unknown) => void
  resolve: (result: SshStartupReconnectBatchResult) => void
  started: boolean
  resultSettled: boolean
  released: boolean
  holdUntilBudget: boolean
  budgetTimer: ReturnType<typeof setTimeout> | null
  removeAbortListener: () => void
}

function remainingBudgetMs(deadline: number): number {
  return Math.max(0, deadline - performance.now())
}

function isConnectAlreadyInProgress(error: unknown): boolean {
  return error instanceof Error && /Connection to .+ is already in progress/.test(error.message)
}

export class SshStartupReconnectScheduler {
  private activeCount = 0
  private readonly queue: ScheduledReconnect[] = []

  constructor(private readonly concurrency = SSH_STARTUP_RECONNECT_CONCURRENCY) {}

  schedule(args: {
    targetId: string
    deadline: number
    signal: AbortSignal
    connect: () => Promise<SshConnectionState | null>
    publishState: (state: SshConnectionState) => void
    onFailure: (error: unknown) => void
  }): Promise<SshStartupReconnectBatchResult> {
    return new Promise((resolve) => {
      const task: ScheduledReconnect = {
        ...args,
        resolve,
        started: false,
        resultSettled: false,
        released: false,
        holdUntilBudget: false,
        budgetTimer: null,
        removeAbortListener: () => {}
      }
      const finish = (outcome: SshStartupReconnectOutcome): void => {
        if (task.resultSettled) {
          return
        }
        task.resultSettled = true
        task.resolve({ targetId: task.targetId, outcome })
      }
      const onAbort = (): void => {
        if (!task.started) {
          this.removeQueuedTask(task)
          this.clearTaskTimer(task)
          task.removeAbortListener()
          finish('cancelled')
          this.drain()
          return
        }
        finish('cancelled')
      }
      args.signal.addEventListener('abort', onAbort, { once: true })
      task.removeAbortListener = () => args.signal.removeEventListener('abort', onAbort)

      if (args.signal.aborted) {
        onAbort()
        return
      }
      const budgetMs = remainingBudgetMs(args.deadline)
      if (budgetMs <= 0) {
        task.removeAbortListener()
        finish('not-started-budget')
        return
      }
      task.budgetTimer = setTimeout(() => {
        task.budgetTimer = null
        if (!task.started) {
          this.removeQueuedTask(task)
          task.removeAbortListener()
          finish('not-started-budget')
          this.drain()
          return
        }
        if (task.holdUntilBudget) {
          this.release(task)
          return
        }
        if (!task.resultSettled && !task.signal.aborted) {
          const error = new Error('SSH reconnect timeout')
          task.onFailure(error)
          finish('timed-out')
        }
      }, budgetMs)
      this.queue.push(task)
      this.drain()
    })
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!
      if (task.signal.aborted || remainingBudgetMs(task.deadline) <= 0) {
        this.clearTaskTimer(task)
        task.removeAbortListener()
        if (!task.resultSettled) {
          task.resolve({
            targetId: task.targetId,
            outcome: task.signal.aborted ? 'cancelled' : 'not-started-budget'
          })
          task.resultSettled = true
        }
        continue
      }
      this.start(task)
    }
  }

  private start(task: ScheduledReconnect): void {
    task.started = true
    this.activeCount++
    void Promise.resolve()
      .then(task.connect)
      .then(
        (state) => {
          if (!task.resultSettled && !task.signal.aborted) {
            if (state) {
              task.publishState(state)
            }
            task.resultSettled = true
            task.resolve({ targetId: task.targetId, outcome: 'completed' })
          }
          this.release(task)
        },
        (error: unknown) => {
          if (isConnectAlreadyInProgress(error) && remainingBudgetMs(task.deadline) > 0) {
            task.holdUntilBudget = true
            if (!task.resultSettled) {
              task.resultSettled = true
              task.resolve({ targetId: task.targetId, outcome: 'in-progress' })
            }
            return
          }
          if (!task.resultSettled && !task.signal.aborted) {
            task.onFailure(error)
            task.resultSettled = true
            task.resolve({ targetId: task.targetId, outcome: 'failed' })
          }
          this.release(task)
        }
      )
  }

  private release(task: ScheduledReconnect): void {
    if (task.released) {
      return
    }
    task.released = true
    this.clearTaskTimer(task)
    task.removeAbortListener()
    this.activeCount--
    this.drain()
  }

  private removeQueuedTask(task: ScheduledReconnect): void {
    const index = this.queue.indexOf(task)
    if (index >= 0) {
      this.queue.splice(index, 1)
    }
  }

  private clearTaskTimer(task: ScheduledReconnect): void {
    if (task.budgetTimer) {
      clearTimeout(task.budgetTimer)
      task.budgetTimer = null
    }
  }
}

const startupReconnectScheduler = new SshStartupReconnectScheduler()

export function resolveSshStartupActiveWorkspaceId(args: {
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
}): string | null {
  return getActiveSidebarWorkspaceId(args.activeWorkspaceKey, args.activeWorktreeId)
}

export function partitionSshStartupReconnectTargets(args: {
  targetIds: readonly string[]
  activeTargetIds: readonly string[]
  activeTabId: string | null
  remoteSessionIdsByTabId?: Readonly<Record<string, string>>
}): { criticalTargetIds: string[]; backgroundTargetIds: string[] } {
  const targetIds = [...new Set(args.targetIds)]
  const eligible = new Set(targetIds)
  const activeTargets = new Set(args.activeTargetIds.filter((id) => eligible.has(id)))
  const sessionTargets = new Set<string>()
  for (const [tabId, sessionId] of Object.entries(args.remoteSessionIdsByTabId ?? {})) {
    const targetId = parseAppSshPtyId(sessionId)?.connectionId
    if (!targetId || !eligible.has(targetId)) {
      continue
    }
    sessionTargets.add(targetId)
    if (tabId === args.activeTabId) {
      activeTargets.add(targetId)
    }
  }
  const criticalTargetIds = targetIds.filter((targetId) => activeTargets.has(targetId))
  return {
    criticalTargetIds,
    backgroundTargetIds: [
      ...targetIds.filter(
        (targetId) => !activeTargets.has(targetId) && sessionTargets.has(targetId)
      ),
      ...targetIds.filter(
        (targetId) => !activeTargets.has(targetId) && !sessionTargets.has(targetId)
      )
    ]
  }
}

export function reconnectSshTargetsForRendererStartup(args: {
  targetIds: readonly string[]
  budgetMs: number
  signal: AbortSignal
  connect: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  onFailure: (targetId: string, error: unknown) => void
  scheduler?: SshStartupReconnectScheduler
}): Promise<SshStartupReconnectBatchResult[]> {
  const deadline = performance.now() + args.budgetMs
  const scheduler = args.scheduler ?? startupReconnectScheduler
  return Promise.all(
    args.targetIds.map((targetId) =>
      scheduler.schedule({
        targetId,
        deadline,
        signal: args.signal,
        connect: () => args.connect(targetId),
        publishState: (state) => args.publishState(targetId, state),
        onFailure: (error) => args.onFailure(targetId, error)
      })
    )
  )
}

export async function reconnectSshTargetForRendererStartup(args: {
  targetId: string
  timeoutMs: number
  connect: (targetId: string) => Promise<SshConnectionState | null>
  publishState: (targetId: string, state: SshConnectionState) => void
  onFailure: (targetId: string, error: unknown) => void
}): Promise<SshStartupReconnectResult> {
  const { targetId, timeoutMs, connect, publishState, onFailure } = args
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error('SSH reconnect timeout')), timeoutMs)
    })
    const state = await Promise.race([connect(targetId), timeout])
    if (state) {
      publishState(targetId, state)
    }
    return { timedOut: false }
  } catch (error) {
    onFailure(targetId, error)
    return {
      timedOut: error instanceof Error && error.message === 'SSH reconnect timeout'
    }
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
  }
}
