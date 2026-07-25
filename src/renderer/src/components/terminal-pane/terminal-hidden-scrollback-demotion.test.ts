import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_DEMOTED_SCROLLBACK_ROWS,
  demotedTerminalScrollbackRows,
  isTerminalWorktreeScrollbackDemoted,
  resetTerminalScrollbackDemotion,
  setScrollbackDemotedTerminalWorktrees,
  subscribeTerminalScrollbackDemotion
} from './terminal-hidden-scrollback-demotion'

afterEach(() => {
  setScrollbackDemotedTerminalWorktrees(new Set())
})

describe('setScrollbackDemotedTerminalWorktrees', () => {
  it('replaces the demoted set', () => {
    setScrollbackDemotedTerminalWorktrees(new Set(['wt-1', 'wt-2']))
    expect(isTerminalWorktreeScrollbackDemoted('wt-1')).toBe(true)
    setScrollbackDemotedTerminalWorktrees(new Set(['wt-2']))
    expect(isTerminalWorktreeScrollbackDemoted('wt-1')).toBe(false)
    expect(isTerminalWorktreeScrollbackDemoted('wt-2')).toBe(true)
  })

  it('does not notify when the set content is unchanged (flip-loop damping)', () => {
    setScrollbackDemotedTerminalWorktrees(new Set(['wt-1']))
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalScrollbackDemotion(listener)
    setScrollbackDemotedTerminalWorktrees(new Set(['wt-1']))
    expect(listener).not.toHaveBeenCalled()
    setScrollbackDemotedTerminalWorktrees(new Set(['wt-1', 'wt-2']))
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('resetTerminalScrollbackDemotion', () => {
  // Why: module state outlives the host, so a stale verdict would demote a pane
  // that remounts before any effect recomputes it.
  it('clears every verdict and notifies subscribers', () => {
    setScrollbackDemotedTerminalWorktrees(new Set(['wt-1', 'wt-2']))
    const listener = vi.fn()
    const unsubscribe = subscribeTerminalScrollbackDemotion(listener)
    resetTerminalScrollbackDemotion()
    expect(isTerminalWorktreeScrollbackDemoted('wt-1')).toBe(false)
    expect(isTerminalWorktreeScrollbackDemoted('wt-2')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('demotedTerminalScrollbackRows', () => {
  it('never exceeds the configured rows', () => {
    expect(demotedTerminalScrollbackRows(50_000)).toBe(TERMINAL_DEMOTED_SCROLLBACK_ROWS)
    expect(demotedTerminalScrollbackRows(500)).toBe(500)
  })
})
