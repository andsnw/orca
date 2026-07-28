import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, trackMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: showMessageBoxMock
  }
}))

vi.mock('../i18n/main-i18n', () => ({
  translateMain: (
    _key: string,
    fallback: string,
    options?: Readonly<Record<string, string>>
  ): string => fallback.replace('{{cause}}', options?.cause ?? '')
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

import {
  classifyRuntimeRpcStartFailure,
  recordRuntimeRpcStartFailure,
  showRuntimeRpcStartupFailureDialog
} from './runtime-rpc-startup-failure'

function createParentWindow(visible = true): Electron.BrowserWindow {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => visible
  }) as unknown as Electron.BrowserWindow
}

describe('runtime RPC startup failure reporting', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset().mockResolvedValue({ response: 0 })
    trackMock.mockReset()
  })

  it.each([
    ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'],
    ['EADDRINUSE', 'address_in_use'],
    ['ENOSPC', 'storage_unavailable'],
    ['EROFS', 'storage_unavailable'],
    ['ENOENT', 'invalid_path'],
    ['ENAMETOOLONG', 'invalid_path'],
    ['unexpected', 'unknown']
  ] as const)('classifies %s without exposing the raw error', (code, expected) => {
    const error = Object.assign(new Error('/Users/private/orca-runtime.json'), { code })

    expect(classifyRuntimeRpcStartFailure(error)).toBe(expected)
  })

  it('records a privacy-safe telemetry event', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = Object.assign(new Error('/Users/private/orca-runtime.json'), { code: 'EACCES' })

    recordRuntimeRpcStartFailure(error)

    expect(trackMock).toHaveBeenCalledWith('runtime_rpc_start_failed', {
      error_class: 'permission_denied'
    })
    expect(trackMock.mock.calls[0]).not.toContainEqual(expect.stringContaining('/Users/private'))
    consoleError.mockRestore()
  })

  it('shows the CLI impact and local cause', async () => {
    const parentWindow = createParentWindow()
    const error = new Error('metadata write failed')

    await showRuntimeRpcStartupFailureDialog(parentWindow, error)

    expect(showMessageBoxMock).toHaveBeenCalledWith(
      parentWindow,
      expect.objectContaining({
        type: 'error',
        title: 'Orca CLI unavailable',
        message: "Orca couldn't start its local command transport.",
        detail: expect.stringMatching(
          /orca status.*orca terminal.*orchestration.*Cause: metadata write failed/s
        )
      })
    )
  })

  it('waits until the app window is visible', async () => {
    const parentWindow = createParentWindow(false)
    const reporting = showRuntimeRpcStartupFailureDialog(
      parentWindow,
      new Error('metadata write failed')
    )

    expect(showMessageBoxMock).not.toHaveBeenCalled()
    parentWindow.emit('show')
    await reporting

    expect(showMessageBoxMock).toHaveBeenCalledOnce()
  })

  it('logs instead of rejecting if Electron cannot show the dialog', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    showMessageBoxMock.mockRejectedValueOnce(new Error('window closed'))

    await expect(
      showRuntimeRpcStartupFailureDialog(createParentWindow(), new Error('failed'))
    ).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalledWith(
      '[runtime] Failed to show RPC startup failure dialog:',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })
})
