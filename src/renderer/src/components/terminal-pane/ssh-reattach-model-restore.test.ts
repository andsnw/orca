import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decideSshReattachPaintSource,
  resolveSshReattachModelSnapshotWithTimeout,
  shouldFetchSshReattachModelSnapshot
} from './ssh-reattach-model-restore'

const SSH_PTY_ID = 'ssh:conn-1@@relay-pty-1'
const LOCAL_PTY_ID = 'repo::/worktree@@session-1'

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveSshReattachModelSnapshotWithTimeout', () => {
  it('degrades a stalled snapshot probe to null', async () => {
    vi.useFakeTimers()
    const pending = new Promise<string>(() => {})
    const resolved = resolveSshReattachModelSnapshotWithTimeout(pending, 25)

    await vi.advanceTimersByTimeAsync(25)
    await expect(resolved).resolves.toBeNull()
  })

  it('passes through a prompt snapshot and degrades rejection to null', async () => {
    await expect(
      resolveSshReattachModelSnapshotWithTimeout(Promise.resolve('snapshot'), 25)
    ).resolves.toBe('snapshot')
    await expect(
      resolveSshReattachModelSnapshotWithTimeout(Promise.reject(new Error('unavailable')), 25)
    ).resolves.toBeNull()
  })
})

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
      { data: '', source: 'headless' as const },
      { data: '', scrollbackAnsi: '', pendingEscapeTailAnsi: '', source: 'headless' as const }
    ]) {
      expect(
        decideSshReattachPaintSource({ ptyId: SSH_PTY_ID, sshParkingEnabled: true, snapshot })
      ).toBe('relay-replay')
    }
  })

  it('judges emptiness on the composed payload, not the screen frame alone', () => {
    // Why: an alt-screen model snapshot can hold all content in scrollbackAnsi
    // with an empty screen; a dangling escape tail alone must also paint.
    for (const snapshot of [
      { data: '', scrollbackAnsi: 'history', source: 'headless' as const },
      { data: '', pendingEscapeTailAnsi: '\x1b[', source: 'headless' as const }
    ]) {
      expect(
        decideSshReattachPaintSource({ ptyId: SSH_PTY_ID, sshParkingEnabled: true, snapshot })
      ).toBe('main-model-snapshot')
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
