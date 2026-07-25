import { useSyncExternalStore } from 'react'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN } from '../../../../shared/terminal-scrollback-policy'

/** Demoted hidden panes keep the minimum retention tier (~1.3MB V8 heap vs
 *  ~19MB at 50k rows, measured); trimmed history is gone by design — reveal
 *  restores the configured cap for future output only. */
export const TERMINAL_DEMOTED_SCROLLBACK_ROWS = DESKTOP_TERMINAL_SCROLLBACK_ROWS_MIN

// Why module state (same pattern as parked watchers): the verdict is computed
// in Terminal.tsx but applied by each mounted pane's lifecycle hook — prop
// threading would cross three component layers for a per-worktree boolean.
const demotedWorktreeIds = new Set<string>()
const listeners = new Set<() => void>()

export function setScrollbackDemotedTerminalWorktrees(next: ReadonlySet<string>): void {
  if (
    next.size === demotedWorktreeIds.size &&
    [...next].every((id) => demotedWorktreeIds.has(id))
  ) {
    return
  }
  demotedWorktreeIds.clear()
  for (const id of next) {
    demotedWorktreeIds.add(id)
  }
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Clear every verdict — the demotion host is gone, so nothing recomputes them.
 * Without this a pane remounting later reads a stale demotion (React runs the
 * pane's scrollback effect BEFORE the host effect that would clear it) and
 * xterm trims its restore replay to 1 000 rows, unrecoverably.
 */
export function resetTerminalScrollbackDemotion(): void {
  setScrollbackDemotedTerminalWorktrees(new Set())
}

export function isTerminalWorktreeScrollbackDemoted(worktreeId: string): boolean {
  return demotedWorktreeIds.has(worktreeId)
}

export function subscribeTerminalScrollbackDemotion(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Live per-worktree demotion verdict for a mounted pane host. */
export function useTerminalWorktreeScrollbackDemoted(worktreeId: string): boolean {
  return useSyncExternalStore(subscribeTerminalScrollbackDemotion, () =>
    demotedWorktreeIds.has(worktreeId)
  )
}

export function demotedTerminalScrollbackRows(configuredRows: number): number {
  return Math.min(TERMINAL_DEMOTED_SCROLLBACK_ROWS, configuredRows)
}
