// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  storeState: {
    pendingStartupByTabId: {} as Record<string, unknown>,
    settings: {} as Record<string, unknown>
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks.storeState)
}))

vi.mock('./terminal-parked-tab-watchers', () => ({
  canWatcherCoverParkedTerminalTab: () => true,
  disposeParkedTerminalWatchersForWorktree: vi.fn(),
  isEvictionExemptTerminalTab: () => false,
  syncParkedTerminalTabWatchers: vi.fn()
}))

import {
  TERMINAL_TAB_COLD_PARK_DELAY_MS,
  TERMINAL_TAB_HOT_RETAIN_MS
} from './terminal-hidden-view-parking'
import { useTerminalTabColdParking } from './use-terminal-tab-cold-parking'

const WORKTREE_ID = 'wt-1'

function terminalTab(id: string): TerminalTab {
  return { id, ptyId: `${WORKTREE_ID}@@session-${id}` } as TerminalTab
}

function hookArgs(shouldMeasureHiddenWorktree: boolean) {
  return {
    worktreeId: WORKTREE_ID,
    terminalTabs: [terminalTab('tab-1'), terminalTab('tab-2')],
    assignments: new Map<string, { groupId: string; isActiveInGroup: boolean }>(),
    isWorktreeActive: false,
    coldParkTerminalPanes: false,
    shouldMeasureHiddenWorktree,
    activityTerminalPortals: [],
    activationDeferredMountTabIds: null
  }
}

describe('useTerminalTabColdParking measure-clock contract', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Why: the worktree layer preserves hiddenSince through a background-measure
  // window; the tab layer must share that contract (no clock reset) while a
  // post-measure cool-down prevents the instant re-park thrash.
  it('preserves tab hiddenSince through a measure window and re-parks only after the cool-down', () => {
    const { result, rerender } = renderHook(
      (args: ReturnType<typeof hookArgs>) => useTerminalTabColdParking(args),
      { initialProps: hookArgs(false) }
    )
    expect(result.current.size).toBe(0)

    // Past hot-retain: tab-1 holds the last-active exemption, tab-2 parks.
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_HOT_RETAIN_MS + 1)
    })
    expect(result.current).toEqual(new Set(['tab-2']))

    // A measure window reveals every tab but must not clear the hidden clock.
    act(() => {
      rerender(hookArgs(true))
    })
    expect(result.current.size).toBe(0)
    act(() => {
      vi.advanceTimersByTime(3_000)
      rerender(hookArgs(false))
    })

    // Measure just ended: the cool-down vetoes an instant re-park (the thrash).
    expect(result.current.size).toBe(0)
    act(() => {
      vi.advanceTimersByTime(TERMINAL_TAB_COLD_PARK_DELAY_MS - 1)
    })
    expect(result.current.size).toBe(0)

    // One cool-down later tab-2 re-parks — proving hiddenSince survived the
    // measure (a cleared clock would demand a fresh 15-minute hot-retain).
    act(() => {
      vi.advanceTimersByTime(2)
    })
    expect(result.current).toEqual(new Set(['tab-2']))
  })
})
