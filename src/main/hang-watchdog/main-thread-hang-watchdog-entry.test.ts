import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeHangRecoveryMarker } from './hang-recovery-marker'

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ unref: vi.fn() }))
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

import { recoverFrozenParent } from './main-thread-hang-watchdog-entry'

describe('recoverFrozenParent', () => {
  let dir: string
  let killSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hang-recover-'))
    spawnMock.mockClear()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    killSpy.mockRestore()
    exitSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the marker, spawns a pid-waiting relauncher, SIGKILLs the parent, and exits', () => {
    const markerPath = join(dir, 'marker.json')
    recoverFrozenParent({
      parentPid: 4242,
      appBundlePath: "/Applications/Or ca's.app",
      markerPath,
      unresponsiveMs: 45_000
    })

    const marker = consumeHangRecoveryMarker(markerPath)
    expect(marker).toMatchObject({ parentPid: 4242, unresponsiveMs: 45_000 })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [shell, args, options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { detached: boolean; stdio: string }
    ]
    expect(shell).toBe('/bin/sh')
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' })
    const script = args[1]
    // Why: the relauncher must wait for the exact pid to die (single-instance lock) and shell-quote the bundle path.
    expect(script).toContain('while kill -0 4242')
    expect(script).toContain(`open '/Applications/Or ca'\\''s.app'`)

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('scrubs ELECTRON_RUN_AS_NODE and watchdog config from the relauncher env', () => {
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS = '6000'
    try {
      recoverFrozenParent({
        parentPid: 4242,
        appBundlePath: '/Applications/Orca.app',
        markerPath: join(dir, 'marker.json'),
        unresponsiveMs: 45_000
      })
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE
      delete process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS
    }
    const [, , options] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string | undefined> }
    ]
    // Why: `open` propagates this env to the relaunched app; ELECTRON_RUN_AS_NODE would boot it as bare Node and it would exit immediately.
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(options.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS).toBeUndefined()
    expect(options.env.PATH).toBeDefined()
  })

  it('still kills the parent when there is no bundle path or the marker write fails', () => {
    recoverFrozenParent({
      parentPid: 4242,
      appBundlePath: '',
      markerPath: join(dir, 'missing-subdir', 'marker.json'),
      unresponsiveMs: 45_000
    })
    expect(spawnMock).not.toHaveBeenCalled()
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL')
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
