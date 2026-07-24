import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  consumeHangRecoveryMarker,
  hangRecoveryMarkerPath,
  writeHangRecoveryMarker
} from './hang-recovery-marker'

describe('hang recovery marker', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hang-marker-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a marker and deletes it on consume', () => {
    const markerPath = hangRecoveryMarkerPath(dir)
    writeHangRecoveryMarker(markerPath, { detectedAt: 123, parentPid: 456, unresponsiveMs: 45000 })
    expect(consumeHangRecoveryMarker(markerPath)).toEqual({
      detectedAt: 123,
      parentPid: 456,
      unresponsiveMs: 45000
    })
    expect(existsSync(markerPath)).toBe(false)
    expect(consumeHangRecoveryMarker(markerPath)).toBeNull()
  })

  it('returns null for a missing marker', () => {
    expect(consumeHangRecoveryMarker(hangRecoveryMarkerPath(dir))).toBeNull()
  })

  it('returns null for corrupted or incomplete markers and still deletes them', () => {
    const markerPath = hangRecoveryMarkerPath(dir)
    writeFileSync(markerPath, 'not json')
    expect(consumeHangRecoveryMarker(markerPath)).toBeNull()
    expect(existsSync(markerPath)).toBe(false)

    writeFileSync(markerPath, JSON.stringify({ detectedAt: 1 }))
    expect(consumeHangRecoveryMarker(markerPath)).toBeNull()
    expect(existsSync(markerPath)).toBe(false)
  })
})
