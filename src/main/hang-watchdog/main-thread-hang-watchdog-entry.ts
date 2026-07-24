// Forked with ELECTRON_RUN_AS_NODE from the main process. Watches heartbeats
// from the main thread; if they stop (e.g. the macOS 26 AppKit scene-update
// deadlock), it records a recovery marker, schedules a relaunch, and SIGKILLs
// the deadlocked parent. Must never import electron.
import { spawn } from 'node:child_process'
import { createHangWatchdogChildLoop } from './hang-watchdog-child-loop'
import { writeHangRecoveryMarker } from './hang-recovery-marker'

const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_CHECK_INTERVAL_MS = 5_000

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function recoverFrozenParent(options: {
  parentPid: number
  appBundlePath: string
  markerPath: string
  unresponsiveMs: number
}): void {
  try {
    writeHangRecoveryMarker(options.markerPath, {
      detectedAt: Date.now(),
      parentPid: options.parentPid,
      unresponsiveMs: options.unresponsiveMs
    })
  } catch {
    // Why: recovery must proceed even if the marker cannot be written.
  }
  if (options.appBundlePath) {
    // Why: the relauncher must outlive both this watchdog and the killed app, and must wait for the pid to die so the single-instance lock is free before open.
    spawn(
      '/bin/sh',
      [
        '-c',
        `while kill -0 ${options.parentPid} 2>/dev/null; do sleep 0.2; done; sleep 1; open ${shellQuote(options.appBundlePath)}`
      ],
      { detached: true, stdio: 'ignore' }
    ).unref()
  }
  try {
    process.kill(options.parentPid, 'SIGKILL')
  } catch {
    // Parent already exited on its own.
  }
  process.exit(0)
}

function runWatchdog(parentPid: number): void {
  const appBundlePath = process.env.ORCA_HANG_WATCHDOG_APP_BUNDLE_PATH ?? ''
  const markerPath = process.env.ORCA_HANG_WATCHDOG_MARKER_PATH ?? ''
  const timeoutMs = Number(process.env.ORCA_HANG_WATCHDOG_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS
  const checkIntervalMs =
    Number(process.env.ORCA_HANG_WATCHDOG_CHECK_INTERVAL_MS) || DEFAULT_CHECK_INTERVAL_MS

  const loop = createHangWatchdogChildLoop({
    timeoutMs,
    checkIntervalMs,
    now: () => Date.now(),
    onHangDetected: () =>
      recoverFrozenParent({ parentPid, appBundlePath, markerPath, unresponsiveMs: timeoutMs })
  })

  process.on('message', (message) => {
    const type = (message as { type?: string } | null)?.type
    if (type === 'heartbeat') {
      loop.recordHeartbeat()
    } else if (type === 'shutdown') {
      process.exit(0)
    }
  })
  // Why: a normal parent exit closes the IPC channel; the watchdog must not outlive it and misfire.
  process.on('disconnect', () => process.exit(0))
  setInterval(() => loop.tick(), checkIntervalMs)
}

const configuredParentPid = Number(process.env.ORCA_HANG_WATCHDOG_PARENT_PID)
if (Number.isInteger(configuredParentPid) && configuredParentPid > 0) {
  runWatchdog(configuredParentPid)
}
