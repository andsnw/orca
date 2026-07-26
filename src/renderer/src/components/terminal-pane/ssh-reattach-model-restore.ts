import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export type SshReattachPaintSource = 'main-model-snapshot' | 'relay-replay'

export type SshReattachModelSnapshot = {
  data: string
  source?: 'headless' | 'renderer'
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
}

// Why: relay replay is already available during reattach; a stalled model
// probe must not strand that fallback or hold live PTY bytes indefinitely.
export const SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS = 750

export async function resolveSshReattachModelSnapshotWithTimeout<T>(
  snapshot: Promise<T>,
  timeoutMs = SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      snapshot.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/**
 * Which payload paints an SSH reattach (C1 SSH-parking design gate). Only
 * main's headless model is trusted: a 'renderer'-sourced snapshot serializes a
 * mounted xterm, which no longer exists once the pane parked — anything but a
 * non-empty headless snapshot degrades to the relay replay, never a blank paint.
 * Emptiness is judged on the COMPOSED paint payload (scrollback + screen +
 * escape tail): an alt-screen snapshot can carry all content in scrollbackAnsi
 * with an empty screen frame.
 */
export function decideSshReattachPaintSource(args: {
  ptyId: string
  sshParkingEnabled: boolean
  snapshot: SshReattachModelSnapshot | null
}): SshReattachPaintSource {
  if (!args.sshParkingEnabled || parseAppSshPtyId(args.ptyId) === null) {
    return 'relay-replay'
  }
  if (!args.snapshot || args.snapshot.source !== 'headless') {
    return 'relay-replay'
  }
  const composedLength =
    (args.snapshot.scrollbackAnsi?.length ?? 0) +
    args.snapshot.data.length +
    (args.snapshot.pendingEscapeTailAnsi?.length ?? 0)
  return composedLength === 0 ? 'relay-replay' : 'main-model-snapshot'
}

/** Skip the snapshot fetch entirely when the paint could never use it. */
export function shouldFetchSshReattachModelSnapshot(args: {
  ptyId: string
  sshParkingEnabled: boolean
}): boolean {
  return args.sshParkingEnabled && parseAppSshPtyId(args.ptyId) !== null
}
