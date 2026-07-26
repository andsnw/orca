import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import {
  TERMINAL_WORKTREE_COLD_PARK_DELAY_MS,
  isSnapshotBackedTerminalPty,
  selectIdsBeyondHotRetain,
  type ColdParkRetainCandidate,
  type TerminalColdParkPolicyOverrides
} from './terminal-hidden-view-parking'

// Why these sizes (C1, DESIGN.md §2): a retained hidden pane costs a measured
// ~2.5MB of V8 heap at the 5k-row default scrollback and ~19MB at 50k (plus
// per-pane queues), not the ~4-5MB per WORKTREE the warm cap assumed — so
// un-parkable worktrees (pty classes parking can't restore) get a hard
// retention budget: at most 12 stay mounted while hidden, and none past 45
// minutes, evicted least-recently-hidden first via force-park.
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT = 12
export const TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS = 45 * 60_000

// Why: an eviction-exempt pty is a live local one a remount could not reattach
// (daemon-fail-open separator-less ids, ptys minted under another worktree) — a
// fresh spawn would orphan the live shell. Its TAB keeps its mounted pane when
// the worktree force-parks (per-tab exclusion, mirroring Activity portals).
// Per-PTY, not per-tab: the coverage veto that makes a worktree a retention
// candidate walks every split pane, so the exemption must too (see
// isEvictionExemptTerminalTab).
export function isEvictionExemptTerminalPty(
  ptyId: string | null | undefined,
  worktreeId: string
): boolean {
  if (!ptyId || isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId)) {
    return false
  }
  return !isSnapshotBackedTerminalPty(ptyId, worktreeId)
}

export type TerminalWorktreeRetentionCandidate = {
  worktreeId: string
  hiddenSinceMs: number | null
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  hasActivityTerminalPortal: boolean
  /** Post-measure cool-down (see TerminalWorktreeColdParkCandidate): force-park
   *  must not re-engage right after a measure window ends, but hiddenSince —
   *  and with it the TTL/ranking clock — stays untouched. */
  parkCooldownUntilMs?: number | null
  /** Ordinary cold parking can evict this worktree (park-eligible AND watcher-coverable) — the warm cap bounds it already. */
  ordinaryParkingCovers: boolean
  /** See isEvictionExemptTerminalTab. */
  hasEvictionExemptTab: boolean
  /** Pending startup or activation spawn — a mount is imminent; never evict. */
  hasPendingSpawnWork: boolean
}

/**
 * Retention budget over the worktrees ordinary parking can never evict: any
 * hidden un-parkable worktree beyond the retention limit or TTL force-parks —
 * panes unmount, watchers cover the tabs whose transport exists, and reveal
 * restores per pty class (the app-restart experience). Eviction-exempt tabs
 * do NOT veto the worktree: they keep their mounted panes via the per-tab
 * exclusion (Activity-portal pattern) while sibling tabs unmount, so one
 * exempt tab can no longer pin co-located remote-runtime tabs forever.
 * Ranking reuses the hot-retain machinery, so the last-active exemption and
 * deterministic ties hold here too, and the verdict changes only at deadlines
 * or on real state transitions (no new flip-loop inputs).
 */
export function selectRetentionForceParkedTerminalWorktrees(
  args: {
    worktrees: readonly TerminalWorktreeRetentionCandidate[]
    parkingEnabled: boolean
    retentionBudgetEnabled: boolean
    nowMs: number
  } & TerminalColdParkPolicyOverrides
): Set<string> {
  if (!args.parkingEnabled || !args.retentionBudgetEnabled) {
    return new Set()
  }
  const coldParkDelayMs = args.coldParkDelayMs ?? TERMINAL_WORKTREE_COLD_PARK_DELAY_MS
  const candidates: ColdParkRetainCandidate[] = []
  for (const worktree of args.worktrees) {
    if (
      worktree.hiddenSinceMs === null ||
      worktree.isVisible ||
      worktree.shouldMeasureHiddenWorktree ||
      worktree.hasActivityTerminalPortal ||
      worktree.ordinaryParkingCovers ||
      worktree.hasPendingSpawnWork ||
      (worktree.parkCooldownUntilMs != null && args.nowMs < worktree.parkCooldownUntilMs) ||
      args.nowMs - worktree.hiddenSinceMs < coldParkDelayMs
    ) {
      continue
    }
    candidates.push({ id: worktree.worktreeId, hiddenSinceMs: worktree.hiddenSinceMs })
  }
  return selectIdsBeyondHotRetain(candidates, {
    nowMs: args.nowMs,
    hotRetainMs: args.retentionTtlMs ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
    hotRetainLimit: args.retentionLimit ?? TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT
  })
}
