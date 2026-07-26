import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureTerminalShutdownBuffersBestEffort,
  shutdownBufferCaptures
} from './shutdown-buffer-captures'

afterEach(() => {
  shutdownBufferCaptures.clear()
})

describe('captureTerminalShutdownBuffersBestEffort', () => {
  it('continues after one tab capture throws', () => {
    const failed = vi.fn(() => {
      throw new Error('layout capture failed')
    })
    const succeeded = vi.fn()
    shutdownBufferCaptures.set('tab-failed', failed)
    shutdownBufferCaptures.set('tab-succeeded', succeeded)

    expect(() =>
      captureTerminalShutdownBuffersBestEffort(['tab-failed', 'tab-succeeded'], {
        includeLocalBuffers: false
      })
    ).not.toThrow()
    expect(failed).toHaveBeenCalledWith({ includeLocalBuffers: false })
    expect(succeeded).toHaveBeenCalledWith({ includeLocalBuffers: false })
  })
})
