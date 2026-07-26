import type {
  WorktreeBaseSubscription,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'

const UNCHANGED_POLLS_BEFORE_IDLE = 3

export type GitCommonPollingCadence = {
  activeIntervalMs: number
  idleIntervalMs: number
  indexBackstopIntervalMs?: number
}

export type AdaptiveGitCommonPollSubscription = WorktreeBaseSubscription & {
  resetCadence: () => void
}

export async function tryTakeGitCommonPollBaseline<T>(
  takeSnapshot: () => Promise<T>
): Promise<T | null> {
  try {
    return await takeSnapshot()
  } catch {
    return null
  }
}

export function startAdaptiveGitCommonPoller(args: {
  cadence: GitCommonPollingCadence
  visibility: WorktreePollerWindowVisibility
  poll: (forceFullScan: boolean) => Promise<{ changed: boolean }>
}): AdaptiveGitCommonPollSubscription {
  const { cadence, visibility, poll } = args
  let disposed = false
  let ticking = false
  let unchangedPolls = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingForceFullScan = false
  let forceRetryNeeded = false
  let activityGeneration = 0
  let lastActivityAt: number | null = null
  let indexBackstopAt =
    cadence.indexBackstopIntervalMs === undefined
      ? Number.POSITIVE_INFINITY
      : performance.now() + cadence.indexBackstopIntervalMs

  const clearTimer = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  const armTimer = (delayMs: number): void => {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      void tick()
    }, delayMs)
    timer.unref?.()
  }

  const resetCadence = (): void => {
    if (disposed) {
      return
    }
    unchangedPolls = 0
    activityGeneration++
    lastActivityAt = performance.now()
    clearTimer()
    if (!ticking && visibility.isWindowVisible()) {
      armTimer(cadence.activeIntervalMs)
    }
  }

  const tick = async (): Promise<void> => {
    clearTimer()
    if (disposed || !visibility.isWindowVisible() || ticking) {
      return
    }
    ticking = true
    const startedAt = performance.now()
    const startingActivityGeneration = activityGeneration
    const requestedForceFullScan = pendingForceFullScan
    pendingForceFullScan = false
    const backstopDue = startedAt >= indexBackstopAt
    const shouldForceFullScan = requestedForceFullScan || forceRetryNeeded || backstopDue
    let succeeded = false
    let changed = false
    try {
      const result = await poll(shouldForceFullScan)
      succeeded = true
      changed = result.changed
      if (shouldForceFullScan && cadence.indexBackstopIntervalMs !== undefined) {
        indexBackstopAt = performance.now() + cadence.indexBackstopIntervalMs
      }
      forceRetryNeeded = false
    } catch {
      forceRetryNeeded ||= shouldForceFullScan
    } finally {
      ticking = false
    }
    if (disposed) {
      return
    }

    const activityDuringPoll = activityGeneration !== startingActivityGeneration
    if (!activityDuringPoll) {
      unchangedPolls = !succeeded || changed ? 0 : unchangedPolls + 1
    }
    if (pendingForceFullScan) {
      void tick()
      return
    }
    if (!visibility.isWindowVisible()) {
      return
    }
    if (forceRetryNeeded) {
      armTimer(cadence.activeIntervalMs)
      return
    }
    const now = performance.now()
    if (activityDuringPoll && lastActivityAt !== null) {
      armTimer(Math.max(0, cadence.activeIntervalMs - (now - lastActivityAt)))
      return
    }
    const intervalMs =
      unchangedPolls >= UNCHANGED_POLLS_BEFORE_IDLE
        ? cadence.idleIntervalMs
        : cadence.activeIntervalMs
    const cadenceDelay = Math.max(0, intervalMs - (now - startedAt))
    const backstopDelay = Math.max(0, indexBackstopAt - now)
    armTimer(Math.min(cadenceDelay, backstopDelay))
  }

  const unsubscribeVisibility = visibility.onWindowBecameVisible(() => {
    if (disposed) {
      return
    }
    unchangedPolls = 0
    activityGeneration++
    lastActivityAt = performance.now()
    pendingForceFullScan = true
    clearTimer()
    if (!ticking) {
      void tick()
    }
  })

  armTimer(cadence.activeIntervalMs)
  return {
    resetCadence,
    unsubscribe: async () => {
      disposed = true
      clearTimer()
      unsubscribeVisibility()
    }
  }
}
