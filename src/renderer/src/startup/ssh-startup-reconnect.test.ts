import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState } from '../../../shared/ssh-types'
import {
  partitionSshStartupReconnectTargets,
  reconnectSshTargetForRendererStartup,
  reconnectSshTargetsForRendererStartup,
  resolveSshStartupActiveWorkspaceId,
  SshStartupReconnectScheduler
} from './ssh-startup-reconnect'

const connectedState: SshConnectionState = {
  targetId: 'ssh-1',
  status: 'connected',
  error: null,
  reconnectAttempt: 0,
  remotePlatform: 'linux'
}

function stateFor(targetId: string): SshConnectionState {
  return { ...connectedState, targetId }
}

function controlledPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('reconnectSshTargetForRendererStartup', () => {
  it('publishes the connect result before startup terminal restoration continues', async () => {
    const publishState = vi.fn()
    const result = await reconnectSshTargetForRendererStartup({
      targetId: 'ssh-1',
      timeoutMs: 1_000,
      connect: vi.fn().mockResolvedValue(connectedState),
      publishState,
      onFailure: vi.fn()
    })

    expect(result).toEqual({ timedOut: false })
    expect(publishState).toHaveBeenCalledWith('ssh-1', connectedState)
  })

  it('marks a stalled connect as deferred without publishing stale state', async () => {
    vi.useFakeTimers()
    const publishState = vi.fn()
    const onFailure = vi.fn()
    const resultPromise = reconnectSshTargetForRendererStartup({
      targetId: 'ssh-1',
      timeoutMs: 1_000,
      connect: () => new Promise(() => {}),
      publishState,
      onFailure
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toEqual({ timedOut: true })
    expect(publishState).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith('ssh-1', expect.any(Error))
  })
})

describe('partitionSshStartupReconnectTargets', () => {
  it('unwraps an active worktree key before connection-owner resolution', () => {
    expect(
      resolveSshStartupActiveWorkspaceId({
        activeWorkspaceKey: 'worktree:repo-1::/remote/project',
        activeWorktreeId: 'stale-worktree'
      })
    ).toBe('repo-1::/remote/project')
    expect(
      resolveSshStartupActiveWorkspaceId({
        activeWorkspaceKey: 'folder:folder-1',
        activeWorktreeId: null
      })
    ).toBe('folder:folder-1')
  })

  it('prioritizes active targets, then persisted sessions, in stable target order', () => {
    expect(
      partitionSshStartupReconnectTargets({
        targetIds: ['idle-a', 'session-b', 'active-c', 'session-d', 'active-c'],
        activeTargetIds: ['active-c', 'missing'],
        activeTabId: 'tab-active',
        remoteSessionIdsByTabId: {
          'tab-other': 'ssh:session-b@@pty-1',
          'tab-active': 'ssh:session-d@@pty-2',
          malformed: 'relay-pty-without-target',
          stale: 'ssh:missing@@pty-3'
        }
      })
    ).toEqual({
      criticalTargetIds: ['active-c', 'session-d'],
      backgroundTargetIds: ['session-b', 'idle-a']
    })
  })
})

describe('reconnectSshTargetsForRendererStartup', () => {
  it('bounds raw concurrent attempts and starts queued targets as slots settle', async () => {
    const scheduler = new SshStartupReconnectScheduler(2)
    const controls = new Map<string, ReturnType<typeof controlledPromise<SshConnectionState>>>()
    let active = 0
    let peak = 0
    const starts: string[] = []
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-1', 'ssh-2', 'ssh-3', 'ssh-4'],
      budgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        active++
        peak = Math.max(peak, active)
        const control = controlledPromise<SshConnectionState>()
        controls.set(targetId, control)
        return control.promise.finally(() => {
          active--
        })
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.waitFor(() => expect(starts).toEqual(['ssh-1', 'ssh-2']))
    controls.get('ssh-1')!.resolve(stateFor('ssh-1'))
    await vi.waitFor(() => expect(starts).toEqual(['ssh-1', 'ssh-2', 'ssh-3']))
    controls.get('ssh-2')!.resolve(stateFor('ssh-2'))
    await vi.waitFor(() => expect(starts).toEqual(['ssh-1', 'ssh-2', 'ssh-3', 'ssh-4']))
    controls.get('ssh-3')!.resolve(stateFor('ssh-3'))
    controls.get('ssh-4')!.resolve(stateFor('ssh-4'))

    await expect(resultPromise).resolves.toEqual(
      ['ssh-1', 'ssh-2', 'ssh-3', 'ssh-4'].map((targetId) => ({
        targetId,
        outcome: 'completed'
      }))
    )
    expect(peak).toBe(2)
  })

  it('uses one batch budget and never starts targets still queued at expiry', async () => {
    vi.useFakeTimers()
    const starts: string[] = []
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-stalled', 'ssh-queued'],
      budgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler: new SshStartupReconnectScheduler(1),
      connect: (targetId) => {
        starts.push(targetId)
        return new Promise(() => {})
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(1_000)

    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-stalled', outcome: 'timed-out' },
      { targetId: 'ssh-queued', outcome: 'not-started-budget' }
    ])
    expect(starts).toEqual(['ssh-stalled'])
  })

  it('cancels queued results and suppresses late state publication', async () => {
    const scheduler = new SshStartupReconnectScheduler(1)
    const abortController = new AbortController()
    const first = controlledPromise<SshConnectionState>()
    const starts: string[] = []
    const publishState = vi.fn()
    const onFailure = vi.fn()
    const resultPromise = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-started', 'ssh-queued'],
      budgetMs: 1_000,
      signal: abortController.signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return first.promise
      },
      publishState,
      onFailure
    })

    await vi.waitFor(() => expect(starts).toEqual(['ssh-started']))
    abortController.abort()
    await expect(resultPromise).resolves.toEqual([
      { targetId: 'ssh-started', outcome: 'cancelled' },
      { targetId: 'ssh-queued', outcome: 'cancelled' }
    ])

    first.resolve(stateFor('ssh-started'))
    await first.promise
    await Promise.resolve()
    expect(starts).toEqual(['ssh-started'])
    expect(publishState).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('retains capacity for duplicate in-progress rejections until the first budget ends', async () => {
    vi.useFakeTimers()
    const scheduler = new SshStartupReconnectScheduler(1)
    const starts: string[] = []
    const firstResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-duplicate'],
      budgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: async (targetId) => {
        starts.push(targetId)
        throw new Error('Connection to duplicate host is already in progress')
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await expect(firstResult).resolves.toEqual([
      { targetId: 'ssh-duplicate', outcome: 'in-progress' }
    ])
    const secondResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-next'],
      budgetMs: 2_000,
      signal: new AbortController().signal,
      scheduler,
      connect: async (targetId) => {
        starts.push(targetId)
        return stateFor(targetId)
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.advanceTimersByTimeAsync(999)
    expect(starts).toEqual(['ssh-duplicate'])
    await vi.advanceTimersByTimeAsync(1)
    await expect(secondResult).resolves.toEqual([{ targetId: 'ssh-next', outcome: 'completed' }])
    expect(starts).toEqual(['ssh-duplicate', 'ssh-next'])
  })

  it('keeps an aborted raw attempt in the pool until its connect promise settles', async () => {
    const scheduler = new SshStartupReconnectScheduler(1)
    const firstAbort = new AbortController()
    const first = controlledPromise<SshConnectionState>()
    const starts: string[] = []
    const firstResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-old'],
      budgetMs: 1_000,
      signal: firstAbort.signal,
      scheduler,
      connect: (targetId) => {
        starts.push(targetId)
        return first.promise
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })

    await vi.waitFor(() => expect(starts).toEqual(['ssh-old']))
    firstAbort.abort()
    await expect(firstResult).resolves.toEqual([{ targetId: 'ssh-old', outcome: 'cancelled' }])

    const nextResult = reconnectSshTargetsForRendererStartup({
      targetIds: ['ssh-new'],
      budgetMs: 1_000,
      signal: new AbortController().signal,
      scheduler,
      connect: async (targetId) => {
        starts.push(targetId)
        return stateFor(targetId)
      },
      publishState: vi.fn(),
      onFailure: vi.fn()
    })
    await Promise.resolve()
    expect(starts).toEqual(['ssh-old'])

    first.resolve(stateFor('ssh-old'))
    await expect(nextResult).resolves.toEqual([{ targetId: 'ssh-new', outcome: 'completed' }])
    expect(starts).toEqual(['ssh-old', 'ssh-new'])
  })
})
