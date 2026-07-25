import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export type SshReattachPaintSource = 'main-model-snapshot' | 'relay-replay'

export type SshReattachModelSnapshot = {
  data: string
  source?: 'headless' | 'renderer'
}

/**
 * Which payload paints an SSH reattach (C1 SSH-parking design gate). Only
 * main's headless model is trusted: a 'renderer'-sourced snapshot serializes a
 * mounted xterm, which no longer exists once the pane parked — anything but a
 * non-empty headless snapshot degrades to the relay replay, never a blank paint.
 */
export function decideSshReattachPaintSource(args: {
  ptyId: string
  sshParkingEnabled: boolean
  snapshot: SshReattachModelSnapshot | null
}): SshReattachPaintSource {
  if (!args.sshParkingEnabled || parseAppSshPtyId(args.ptyId) === null) {
    return 'relay-replay'
  }
  if (!args.snapshot || args.snapshot.source !== 'headless' || args.snapshot.data.length === 0) {
    return 'relay-replay'
  }
  return 'main-model-snapshot'
}

/** Skip the snapshot fetch entirely when the paint could never use it. */
export function shouldFetchSshReattachModelSnapshot(args: {
  ptyId: string
  sshParkingEnabled: boolean
}): boolean {
  return args.sshParkingEnabled && parseAppSshPtyId(args.ptyId) !== null
}
