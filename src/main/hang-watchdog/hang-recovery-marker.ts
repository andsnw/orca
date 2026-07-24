import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Why: written by the plain-Node watchdog child right before it SIGKILLs a deadlocked main process; consumed by the relaunched app to explain the restart.
export type HangRecoveryMarker = {
  detectedAt: number
  parentPid: number
  unresponsiveMs: number
}

export function hangRecoveryMarkerPath(userDataPath: string): string {
  return join(userDataPath, 'main-thread-hang-recovery.json')
}

export function writeHangRecoveryMarker(markerPath: string, marker: HangRecoveryMarker): void {
  writeFileSync(markerPath, JSON.stringify(marker))
}

export function consumeHangRecoveryMarker(markerPath: string): HangRecoveryMarker | null {
  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return null
  }
  try {
    rmSync(markerPath, { force: true })
  } catch {
    // Why: a marker that cannot be deleted must not block startup; worst case is one repeated recovery notice.
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HangRecoveryMarker>
    if (
      typeof parsed.detectedAt !== 'number' ||
      typeof parsed.parentPid !== 'number' ||
      typeof parsed.unresponsiveMs !== 'number'
    ) {
      return null
    }
    return {
      detectedAt: parsed.detectedAt,
      parentPid: parsed.parentPid,
      unresponsiveMs: parsed.unresponsiveMs
    }
  } catch {
    return null
  }
}
