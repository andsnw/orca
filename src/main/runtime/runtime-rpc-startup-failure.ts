import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'

import type { RuntimeRpcStartErrorClass } from '../../shared/telemetry-events'
import { translateMain } from '../i18n/main-i18n'
import { track } from '../telemetry/client'

const MAX_VISIBLE_CAUSE_LENGTH = 500

const ERROR_CLASS_BY_CODE: Readonly<Record<string, RuntimeRpcStartErrorClass>> = {
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EADDRINUSE: 'address_in_use',
  EDQUOT: 'storage_unavailable',
  EIO: 'storage_unavailable',
  ENOSPC: 'storage_unavailable',
  EROFS: 'storage_unavailable',
  EINVAL: 'invalid_path',
  ENAMETOOLONG: 'invalid_path',
  ENOENT: 'invalid_path',
  ENOTDIR: 'invalid_path'
}

function getErrorCode(error: unknown, seen = new Set<object>()): string | null {
  if (typeof error !== 'object' || error === null || seen.has(error)) {
    return null
  }
  seen.add(error)
  const code = 'code' in error ? error.code : undefined
  if (typeof code === 'string') {
    return code.toUpperCase()
  }
  return 'cause' in error ? getErrorCode(error.cause, seen) : null
}

export function classifyRuntimeRpcStartFailure(error: unknown): RuntimeRpcStartErrorClass {
  const code = getErrorCode(error)
  return (code && ERROR_CLASS_BY_CODE[code]) || 'unknown'
}

function describeRuntimeRpcStartFailure(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : translateMain(
            'runtimeRpc.startupFailure.unknownCause',
            'No additional error details were available.'
          )
  const normalized =
    raw.trim() ||
    translateMain(
      'runtimeRpc.startupFailure.unknownCause',
      'No additional error details were available.'
    )
  return normalized.length <= MAX_VISIBLE_CAUSE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_VISIBLE_CAUSE_LENGTH - 1)}…`
}

function createRuntimeRpcStartupFailureDialogOptions(error: unknown): MessageBoxOptions {
  const cause = describeRuntimeRpcStartFailure(error)
  return {
    type: 'error',
    buttons: [translateMain('runtimeRpc.startupFailure.continueButton', 'Continue without CLI')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: translateMain('runtimeRpc.startupFailure.title', 'Orca CLI unavailable'),
    message: translateMain(
      'runtimeRpc.startupFailure.message',
      "Orca couldn't start its local command transport."
    ),
    detail: translateMain(
      'runtimeRpc.startupFailure.detail',
      'Orca will continue to work, but commands such as orca status, orca terminal, and orchestration are unavailable for this session. Restart Orca to try again.\n\nCause: {{cause}}',
      { cause }
    )
  }
}

export function recordRuntimeRpcStartFailure(error: unknown): void {
  console.error('[runtime] Failed to start local RPC transport:', error)
  track('runtime_rpc_start_failed', {
    error_class: classifyRuntimeRpcStartFailure(error)
  })
}

function waitForWindowToShow(parentWindow: BrowserWindow): Promise<boolean> {
  if (parentWindow.isDestroyed()) {
    return Promise.resolve(false)
  }
  if (parentWindow.isVisible()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const settle = (visible: boolean): void => {
      parentWindow.removeListener('show', onShow)
      parentWindow.removeListener('closed', onClosed)
      resolve(visible)
    }
    const onShow = (): void => settle(!parentWindow.isDestroyed())
    const onClosed = (): void => settle(false)
    parentWindow.once('show', onShow)
    parentWindow.once('closed', onClosed)
  })
}

export async function showRuntimeRpcStartupFailureDialog(
  parentWindow: BrowserWindow,
  error: unknown
): Promise<void> {
  if (!(await waitForWindowToShow(parentWindow))) {
    return
  }
  try {
    await dialog.showMessageBox(parentWindow, createRuntimeRpcStartupFailureDialogOptions(error))
  } catch (dialogError) {
    console.error('[runtime] Failed to show RPC startup failure dialog:', dialogError)
  }
}
