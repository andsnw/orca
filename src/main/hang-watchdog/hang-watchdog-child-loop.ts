export type HangWatchdogChildLoopConfig = {
  timeoutMs: number
  checkIntervalMs: number
  now: () => number
  onHangDetected: () => void
}

export type HangWatchdogChildLoop = {
  recordHeartbeat: () => void
  tick: () => void
}

export function createHangWatchdogChildLoop(
  config: HangWatchdogChildLoopConfig
): HangWatchdogChildLoop {
  let lastHeartbeatAt = config.now()
  let lastTickAt = config.now()
  let fired = false
  return {
    recordHeartbeat: () => {
      lastHeartbeatAt = config.now()
    },
    tick: () => {
      if (fired) {
        return
      }
      const now = config.now()
      const tickGap = now - lastTickAt
      lastTickAt = now
      // Why: system sleep suspends this process too; a huge tick gap means suspension, not a parent hang, so restart the wait from scratch.
      if (tickGap > config.checkIntervalMs * 3) {
        lastHeartbeatAt = now
        return
      }
      if (now - lastHeartbeatAt > config.timeoutMs) {
        fired = true
        config.onHangDetected()
      }
    }
  }
}
