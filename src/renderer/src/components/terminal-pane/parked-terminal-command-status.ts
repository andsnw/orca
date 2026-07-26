/**
 * Parked-pane command-lifecycle status policy.
 * Why: parking unmounts TerminalPane, so OSC 133;D and Command Code scrape signals went dark.
 * This ports the store-level subset of pty-connection's handlers; the pane-coupled parts
 * (foreground process-confirm ladder, key-intent interrupt inference) stay with the mounted pane.
 */
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { resolveLiveAgentStatusConnectionRouting } from '@/lib/agent-status-connection-ownership'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { useAppStore } from '@/store'

// Mirrors pty-connection.ts COMMAND_CODE_OUTPUT_DONE_SETTLE_MS — the settle window must be
// identical whether the pane is mounted or parked, or park/reveal changes completion timing.
const COMMAND_CODE_OUTPUT_DONE_SETTLE_MS = 1500

export type ParkedTerminalCommandStatusPolicy = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
  onCommandCodeWorking: (prompt: string) => void
  onCommandCodeDone: (prompt: string) => void
  dispose: () => void
}

// Why only 'working': an in-flight turn is the one state a recreated detector can still
// resolve, and it proves the Command Code TUI is live — a stale 'done' row would arm the
// scrape against whatever process replaced it. Shared by parked watchers and the reveal
// remount, which both recreate the detector long past the banner.
export function readInFlightCommandCodeTurn(paneKey: string): { prompt: string } | null {
  const entry = useAppStore.getState().agentStatusByPaneKey?.[paneKey]
  if (entry?.agentType !== 'command-code' || entry.state !== 'working') {
    return null
  }
  return { prompt: entry.prompt }
}

export function createParkedTerminalCommandStatusPolicy(options: {
  ptyId: string
  worktreeId: string
  tabId: string
  /** PaneManager pane id whose runtime-title slot the watcher writes; read for status title pairing. */
  paneId: number
  paneKey: string
}): ParkedTerminalCommandStatusPolicy {
  const { ptyId, worktreeId, tabId, paneId, paneKey } = options
  let disposed = false
  let commandCodeOutputDoneTimer: ReturnType<typeof setTimeout> | null = null
  // Non-null exactly while a done-settle timer pends; lets dispose flush the settle.
  let pendingCommandCodeDonePrompt: string | null = null

  const clearCommandCodeOutputDoneTimer = (): void => {
    if (commandCodeOutputDoneTimer !== null) {
      clearTimeout(commandCodeOutputDoneTimer)
      commandCodeOutputDoneTimer = null
    }
    pendingCommandCodeDonePrompt = null
  }

  const resolveRouting = (): ReturnType<typeof resolveLiveAgentStatusConnectionRouting> => {
    if (disposed) {
      return undefined
    }
    const state = useAppStore.getState()
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey,
      ptyId,
      expectedConnectionId: getConnectionIdFromState(state, worktreeId)
    })
  }

  // Port of pty-connection's dropCommandFinishedStatusIfSameTurn, minus the interrupt-inference
  // option: parked panes receive no key events, so inference never has evidence here.
  const dropCommandFinishedStatusIfSameTurn = (entry: AgentStatusEntry | undefined): void => {
    const state = useAppStore.getState()
    if (!entry) {
      // Why: an Orca-started agent can exit before its first hook status; clear the launch
      // registry on command exit like the mounted path does.
      state.clearAgentLaunchConfig(paneKey)
      return
    }
    const current = state.agentStatusByPaneKey[paneKey]
    if (!current) {
      state.clearAgentLaunchConfig(paneKey)
      return
    }
    const unchanged =
      current.state === entry.state &&
      current.prompt === entry.prompt &&
      current.updatedAt === entry.updatedAt &&
      current.stateStartedAt === entry.stateStartedAt &&
      current.agentType === entry.agentType
    if (!unchanged) {
      return
    }
    state.dropAgentStatus(paneKey)
  }

  // Shared by the settle timer and the dispose flush: complete the row only while it is
  // still this turn's command-code/working entry.
  const settleCommandCodeDone = (normalizedPrompt: string): void => {
    const routing = resolveRouting()
    if (!routing) {
      return
    }
    const currentState = useAppStore.getState()
    const currentEntry = currentState.agentStatusByPaneKey[paneKey]
    if (currentEntry?.agentType !== 'command-code' || currentEntry.state !== 'working') {
      return
    }
    const currentPrompt = currentEntry.prompt.trim()
    if (currentPrompt && currentPrompt !== normalizedPrompt) {
      return
    }
    const currentTitle = currentState.runtimePaneTitlesByTabId?.[tabId]?.[paneId]
    currentState.setAgentStatus(
      paneKey,
      {
        state: 'done',
        prompt: currentPrompt || normalizedPrompt,
        agentType: 'command-code'
      },
      currentTitle,
      undefined,
      routing
    )
  }

  return {
    onCommandFinished: (): void => {
      if (disposed) {
        return
      }
      // Why: the finished command may have moved HEAD or the index (an agent running
      // `git checkout` in a parked worktree); nudge git UI now instead of waiting for a poll.
      dispatchTerminalCommandFinishedEvent(worktreeId)
      // Why: drop the same-turn status row only for SSH PTYs — exact parity with the mounted
      // path, whose foreground tracker refuses SSH ids and drops un-probed. Local PTYs need
      // pty-connection's process-confirm ladder to tell a leaked nested-shell 133;D from a
      // real agent exit, so their drop stays with the mounted pane.
      if (parseAppSshPtyId(ptyId) === null) {
        return
      }
      dropCommandFinishedStatusIfSameTurn(useAppStore.getState().agentStatusByPaneKey[paneKey])
    },

    // Port of pty-connection's seedCommandCodeOutputWorkingStatus (store-level only).
    onCommandCodeWorking: (prompt: string): void => {
      clearCommandCodeOutputDoneTimer()
      const routing = resolveRouting()
      if (!routing) {
        return
      }
      const currentState = useAppStore.getState()
      const currentEntry = currentState.agentStatusByPaneKey[paneKey]
      const currentTitle = currentState.runtimePaneTitlesByTabId?.[tabId]?.[paneId]
      const normalizedPrompt = prompt.trim()
      if (
        currentEntry?.agentType === 'command-code' &&
        currentEntry.state === 'done' &&
        (!normalizedPrompt || normalizedPrompt === currentEntry.prompt.trim())
      ) {
        return
      }
      currentState.setAgentStatus(
        paneKey,
        {
          state: 'working',
          prompt:
            normalizedPrompt || (currentEntry?.state === 'working' ? currentEntry.prompt : ''),
          agentType: 'command-code'
        },
        currentTitle,
        undefined,
        routing
      )
    },

    // Port of pty-connection's scheduleCommandCodeOutputDoneStatus: Command Code keeps rendering
    // the composer while tools run, so only complete the row if no active repaint arrives.
    onCommandCodeDone: (prompt: string): void => {
      clearCommandCodeOutputDoneTimer()
      const normalizedPrompt = prompt.trim()
      if (!normalizedPrompt) {
        return
      }
      pendingCommandCodeDonePrompt = normalizedPrompt
      commandCodeOutputDoneTimer = setTimeout(() => {
        commandCodeOutputDoneTimer = null
        pendingCommandCodeDonePrompt = null
        if (disposed) {
          return
        }
        settleCommandCodeDone(normalizedPrompt)
      }, COMMAND_CODE_OUTPUT_DONE_SETTLE_MS)
    },

    dispose: (): void => {
      // Why flush, not cancel: reveal disposes mid-settle and the remounted detector cannot
      // re-observe the already-passed idle composer, so cancelling strands the row at
      // 'working'. A rare premature 'done' (tool still running behind the composer) only
      // shortens the settle window; the turn ends at 'done' anyway.
      const pendingPrompt = disposed ? null : pendingCommandCodeDonePrompt
      clearCommandCodeOutputDoneTimer()
      if (pendingPrompt !== null) {
        settleCommandCodeDone(pendingPrompt)
      }
      disposed = true
    }
  }
}
