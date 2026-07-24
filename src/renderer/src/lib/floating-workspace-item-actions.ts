// Cross-boundary primitives for the floating workspace panel, shared by the panel component,
// its React preflight, and the Change E guest-IPC receiver (useIpcEvents) so behavior stays
// single-sourced. See docs/floating-workspace-shortcut-routing-design.md (F3, F-adv, Change E).

// --- One-shot reclaim intent (F3 / F-adv) ---
// A sticky boolean, NOT a focus mirror: set at close-initiation while the panel owns keyboard
// ownership *and only for a close that will empty the panel*, captured before the destructive DOM
// removal (which blurs the pane and would flip a live focus mirror to false first). The panel's
// visibleFloatingItemCount→0 effect consumes it to re-grab keyboard ownership for the next
// Cmd/Ctrl+T. Genuine outside releases (outside pointer-down, window blur to another app) clear it.
let floatingPanelReclaimIntent = false

export function armFloatingPanelReclaimIntent(): void {
  floatingPanelReclaimIntent = true
}

export function consumeFloatingPanelReclaimIntent(): boolean {
  const armed = floatingPanelReclaimIntent
  floatingPanelReclaimIntent = false
  return armed
}

export function clearFloatingPanelReclaimIntent(): void {
  floatingPanelReclaimIntent = false
}

// --- Guest → mounted-panel bridge (Change E) ---
// A focused floating *browser* guest's keystrokes never reach the renderer DOM; the main-process
// guest before-input-event routes them over IPC to useIpcEvents, which (after validating the
// source id) re-dispatches them as these typed window events so the mounted panel handles the
// close/select through the exact same closures the keyboard path uses. Dispatch is synchronous,
// so the reclaim intent set inside the panel's close handler still lands before webview teardown.
export const FLOATING_WORKSPACE_GUEST_CLOSE_EVENT = 'orca:floating-workspace-guest-close'
export const FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT =
  'orca:floating-workspace-guest-select-index'

export type FloatingWorkspaceGuestCloseDetail = {
  /** The floating browser guest's owning source page id (Tab.entityId). */
  sourceId: string
}

export type FloatingWorkspaceGuestSelectIndexDetail = {
  /** Zero-based index of the visible floating tab to select. */
  index: number
}

export function dispatchFloatingWorkspaceGuestClose(
  detail: FloatingWorkspaceGuestCloseDetail
): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(FLOATING_WORKSPACE_GUEST_CLOSE_EVENT, { detail }))
}

export function dispatchFloatingWorkspaceGuestSelectIndex(
  detail: FloatingWorkspaceGuestSelectIndexDetail
): void {
  if (typeof window === 'undefined') {
    return
  }
  window.dispatchEvent(new CustomEvent(FLOATING_WORKSPACE_GUEST_SELECT_INDEX_EVENT, { detail }))
}
