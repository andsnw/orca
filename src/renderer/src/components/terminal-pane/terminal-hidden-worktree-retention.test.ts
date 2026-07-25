import { describe, expect, it } from 'vitest'
import { TERMINAL_WORKTREE_PARK_DELAY_MS } from './terminal-hidden-view-parking'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  isEvictionExemptTerminalTab,
  selectRetentionForceParkedTerminalWorktrees,
  type TerminalWorktreeRetentionCandidate
} from './terminal-hidden-worktree-retention'

describe('isEvictionExemptTerminalTab', () => {
  const worktreeId = 'repo::/worktree'

  it('exempts only live local ptys a remount could not reattach', () => {
    expect(isEvictionExemptTerminalTab({ ptyId: 'pty-local-detached' }, worktreeId)).toBe(true)
    expect(isEvictionExemptTerminalTab({ ptyId: 'other::wt@@session-1' }, worktreeId)).toBe(true)
  })

  it('never exempts snapshot-backed, SSH, remote-runtime, or unbound tabs', () => {
    expect(isEvictionExemptTerminalTab({ ptyId: `${worktreeId}@@session-1` }, worktreeId)).toBe(
      false
    )
    expect(isEvictionExemptTerminalTab({ ptyId: 'ssh:conn-1@@pty-1' }, worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalTab({ ptyId: 'remote:env-1@@t-1' }, worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalTab({ ptyId: null }, worktreeId)).toBe(false)
  })
})

describe('selectRetentionForceParkedTerminalWorktrees', () => {
  const nowMs = 5_000_000

  function retentionCandidate(
    worktreeId: string,
    hiddenSinceMs: number | null,
    partial: Partial<TerminalWorktreeRetentionCandidate> = {}
  ): TerminalWorktreeRetentionCandidate {
    return {
      worktreeId,
      hiddenSinceMs,
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      ordinaryParkingCovers: false,
      hasEvictionExemptTab: false,
      hasPendingSpawnWork: false,
      ...partial
    }
  }

  const base = {
    parkingEnabled: true,
    retentionBudgetEnabled: true,
    nowMs
  }

  it('returns empty when either kill switch is off', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS)
    ]
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, parkingEnabled: false })
    ).toEqual(new Set())
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionBudgetEnabled: false
      })
    ).toEqual(new Set())
  })

  it('force-parks the least-recently-hidden candidates beyond the retention limit', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 3),
      retentionCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2),
      retentionCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-4', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    // Why limit 2: wt-4 is last-active exempt, wt-3 fills the remaining slot; the two oldest evict.
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, retentionLimit: 2 })
    ).toEqual(new Set(['wt-1', 'wt-2']))
  })

  it('force-parks past the TTL even under the limit, but never the last-active candidate', () => {
    const worktrees = [
      retentionCandidate('wt-old', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS),
      retentionCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(
      new Set(['wt-old'])
    )
  })

  it('never force-parks visible, measuring, portaled, covered, exempt, pending, or fresh candidates', () => {
    const aged = nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
    const worktrees = [
      retentionCandidate('wt-visible', aged, { isVisible: true }),
      retentionCandidate('wt-measure', aged, { shouldMeasureHiddenWorktree: true }),
      retentionCandidate('wt-portal', aged, { hasActivityTerminalPortal: true }),
      retentionCandidate('wt-covered', aged, { ordinaryParkingCovers: true }),
      retentionCandidate('wt-exempt', aged, { hasEvictionExemptTab: true }),
      retentionCandidate('wt-pending', aged, { hasPendingSpawnWork: true }),
      retentionCandidate('wt-fresh', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS + 1),
      retentionCandidate('wt-unhidden', null)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(new Set())
  })

  it('is idempotent and only grows as time advances (flip-loop dwell)', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 3),
      retentionCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2),
      retentionCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-4', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    const first = selectRetentionForceParkedTerminalWorktrees({
      ...base,
      worktrees,
      retentionLimit: 2
    })
    const second = selectRetentionForceParkedTerminalWorktrees({
      ...base,
      worktrees,
      retentionLimit: 2
    })
    expect(second).toEqual(first)
    // Why: with unchanged inputs, a later evaluation may only ADD members —
    // a verdict that oscillates with time is the React-#185 ingredient.
    for (const laterMs of [nowMs + 1_000, nowMs + TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS]) {
      const later = selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionLimit: 2,
        nowMs: laterMs
      })
      for (const id of first) {
        expect(later.has(id)).toBe(true)
      }
    }
  })
})
