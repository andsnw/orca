import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreePollerWindowVisibility } from './worktree-base-directory-poller'
import { startAdaptiveGitCommonPoller } from './worktree-git-common-poll-cadence'

function createVisibilityHarness(): {
  source: WorktreePollerWindowVisibility
  hide: () => void
  show: () => void
} {
  let visible = true
  let listener: (() => void) | null = null
  return {
    source: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (nextListener) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) {
            listener = null
          }
        }
      }
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
      listener?.()
    }
  }
}

function controlledPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('adaptive git-common poll cadence', () => {
  it('backs off after three unchanged polls and returns fast after a change', async () => {
    vi.useFakeTimers()
    const changes = [false, false, false, true, false]
    const poll = vi.fn(async () => ({ changed: changes.shift() ?? false }))
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(499)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(99)
    expect(poll).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(5)

    await subscription.unsubscribe()
  })

  it('caps an idle delay at the monotonic index backstop deadline', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 700
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(699)
    expect(forced).toEqual([false, false, false])
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, false, true])

    await subscription.unsubscribe()
  })

  it('retries a failed overdue scan at the nonzero active cadence', async () => {
    vi.useFakeTimers()
    const forced: boolean[] = []
    let failFirstForcedScan = true
    const subscription = startAdaptiveGitCommonPoller({
      cadence: {
        activeIntervalMs: 100,
        idleIntervalMs: 500,
        indexBackstopIntervalMs: 300
      },
      visibility: createVisibilityHarness().source,
      poll: async (forceFullScan) => {
        forced.push(forceFullScan)
        if (forceFullScan && failFirstForcedScan) {
          failFirstForcedScan = false
          throw new Error('transient stat failure')
        }
        return { changed: false }
      }
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(forced).toEqual([false, false, true])
    await vi.advanceTimersByTimeAsync(99)
    expect(forced).toEqual([false, false, true])
    await vi.advanceTimersByTimeAsync(1)
    expect(forced).toEqual([false, false, true, true])

    await subscription.unsubscribe()
  })

  it('forces every visibility resume and coalesces one behind an in-flight poll', async () => {
    vi.useFakeTimers()
    const visibility = createVisibilityHarness()
    const first = controlledPromise<{ changed: boolean }>()
    const forced: boolean[] = []
    const poll = vi.fn((forceFullScan: boolean) => {
      forced.push(forceFullScan)
      return forced.length === 1 ? first.promise : Promise.resolve({ changed: false })
    })
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: visibility.source,
      poll
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(forced).toEqual([false])
    visibility.show()
    expect(forced).toEqual([false])

    first.resolve({ changed: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(forced).toEqual([false, true])

    await subscription.unsubscribe()
  })

  it('replaces an outstanding idle timer when native activity resets cadence', async () => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => ({ changed: false }))
    const subscription = startAdaptiveGitCommonPoller({
      cadence: { activeIntervalMs: 100, idleIntervalMs: 500 },
      visibility: createVisibilityHarness().source,
      poll
    })

    await vi.advanceTimersByTimeAsync(300)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(50)
    subscription.resetCadence()
    await vi.advanceTimersByTimeAsync(99)
    expect(poll).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(4)

    await subscription.unsubscribe()
  })
})
