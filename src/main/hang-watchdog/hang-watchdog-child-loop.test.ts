import { describe, expect, it, vi } from 'vitest'
import { createHangWatchdogChildLoop } from './hang-watchdog-child-loop'

const TIMEOUT_MS = 45_000
const CHECK_INTERVAL_MS = 5_000

function loopWithClock(startAt = 0) {
  let now = startAt
  const onHangDetected = vi.fn()
  const loop = createHangWatchdogChildLoop({
    timeoutMs: TIMEOUT_MS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    now: () => now,
    onHangDetected
  })
  return { loop, onHangDetected, advance: (ms: number) => (now += ms) }
}

describe('createHangWatchdogChildLoop', () => {
  it('does not fire while heartbeats keep arriving', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    for (let i = 0; i < 100; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.recordHeartbeat()
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('fires once when heartbeats stop for longer than the timeout', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 12; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
    advance(CHECK_INTERVAL_MS)
    loop.tick()
    expect(onHangDetected).toHaveBeenCalledTimes(1)
  })

  it('does not fire at exactly the timeout boundary', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    for (let i = 0; i < 9; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
  })

  it('treats a large tick gap as system sleep and restarts the wait', () => {
    const { loop, onHangDetected, advance } = loopWithClock()
    loop.recordHeartbeat()
    // Simulate suspension: the check timer did not run for far longer than the timeout.
    advance(TIMEOUT_MS * 4)
    loop.tick()
    expect(onHangDetected).not.toHaveBeenCalled()
    // A responsive parent resumes heartbeats after wake; the loop must fire only after a fresh full timeout of silence.
    for (let i = 0; i < 9; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).not.toHaveBeenCalled()
    for (let i = 0; i < 3; i++) {
      advance(CHECK_INTERVAL_MS)
      loop.tick()
    }
    expect(onHangDetected).toHaveBeenCalledTimes(1)
  })
})
