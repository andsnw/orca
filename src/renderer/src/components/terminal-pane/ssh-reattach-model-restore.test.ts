import { describe, expect, it } from 'vitest'
import {
  decideSshReattachPaintSource,
  shouldFetchSshReattachModelSnapshot
} from './ssh-reattach-model-restore'

const SSH_PTY_ID = 'ssh:conn-1@@relay-pty-1'
const LOCAL_PTY_ID = 'repo::/worktree@@session-1'

describe('shouldFetchSshReattachModelSnapshot', () => {
  it('fetches only for SSH ptys with SSH parking enabled', () => {
    expect(
      shouldFetchSshReattachModelSnapshot({ ptyId: SSH_PTY_ID, sshParkingEnabled: true })
    ).toBe(true)
    expect(
      shouldFetchSshReattachModelSnapshot({ ptyId: SSH_PTY_ID, sshParkingEnabled: false })
    ).toBe(false)
    expect(
      shouldFetchSshReattachModelSnapshot({ ptyId: LOCAL_PTY_ID, sshParkingEnabled: true })
    ).toBe(false)
  })
})

describe('decideSshReattachPaintSource', () => {
  const headless = { data: 'screen', source: 'headless' as const }

  it('paints from the main model only for a non-empty headless snapshot', () => {
    expect(
      decideSshReattachPaintSource({
        ptyId: SSH_PTY_ID,
        sshParkingEnabled: true,
        snapshot: headless
      })
    ).toBe('main-model-snapshot')
  })

  it('degrades to relay replay on null, renderer-sourced, sourceless, or empty snapshots', () => {
    for (const snapshot of [
      null,
      { data: 'screen', source: 'renderer' as const },
      { data: 'screen' },
      { data: '', source: 'headless' as const }
    ]) {
      expect(
        decideSshReattachPaintSource({ ptyId: SSH_PTY_ID, sshParkingEnabled: true, snapshot })
      ).toBe('relay-replay')
    }
  })

  it('never upgrades when the kill switch is off or the pty is not SSH', () => {
    expect(
      decideSshReattachPaintSource({
        ptyId: SSH_PTY_ID,
        sshParkingEnabled: false,
        snapshot: headless
      })
    ).toBe('relay-replay')
    expect(
      decideSshReattachPaintSource({
        ptyId: LOCAL_PTY_ID,
        sshParkingEnabled: true,
        snapshot: headless
      })
    ).toBe('relay-replay')
  })
})
