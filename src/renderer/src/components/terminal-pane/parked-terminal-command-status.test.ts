import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const PTY_ID_LOCAL = 'pty-1'
const PTY_ID_SSH = 'ssh:target-1@@pty-9'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const PANE_KEY = `${TAB_ID}:11111111-1111-4111-8111-111111111111`
const PANE_ID = 1
// Mirrors COMMAND_CODE_OUTPUT_DONE_SETTLE_MS.
const DONE_SETTLE_MS = 1500

const ROUTING = { connectionId: null }

type MockStoreState = {
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  runtimePaneTitlesByTabId: Record<string, Record<number, string | undefined>>
  setAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
}

let mockStoreState: MockStoreState
const dispatchTerminalCommandFinishedEvent = vi.fn()
const resolveLiveAgentStatusConnectionRouting = vi.fn()
const getConnectionIdFromState = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockStoreState }
}))
vi.mock('@/hooks/terminal-command-finished-event', () => ({
  dispatchTerminalCommandFinishedEvent
}))
vi.mock('@/lib/agent-status-connection-ownership', () => ({
  resolveLiveAgentStatusConnectionRouting
}))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdFromState
}))

function makeStatusEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'build the feature',
    agentType: 'claude',
    updatedAt: 1000,
    stateStartedAt: 1000,
    ...overrides
  } as AgentStatusEntry
}

async function createPolicy(ptyId: string) {
  const { createParkedTerminalCommandStatusPolicy } =
    await import('./parked-terminal-command-status')
  return createParkedTerminalCommandStatusPolicy({
    ptyId,
    worktreeId: WORKTREE_ID,
    tabId: TAB_ID,
    paneId: PANE_ID,
    paneKey: PANE_KEY
  })
}

describe('createParkedTerminalCommandStatusPolicy', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dispatchTerminalCommandFinishedEvent.mockClear()
    resolveLiveAgentStatusConnectionRouting.mockReset().mockReturnValue(ROUTING)
    getConnectionIdFromState.mockReset().mockReturnValue(null)
    mockStoreState = {
      agentStatusByPaneKey: {},
      runtimePaneTitlesByTabId: { [TAB_ID]: { [PANE_ID]: '✳ Build feature' } },
      setAgentStatus: vi.fn(),
      dropAgentStatus: vi.fn(),
      clearAgentLaunchConfig: vi.fn()
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeds a Command Code working row with the current pane title', async () => {
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      { state: 'working', prompt: 'Fix the spinner', agentType: 'command-code' },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('writes nothing when connection routing does not resolve', async () => {
    resolveLiveAgentStatusConnectionRouting.mockReturnValue(undefined)
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('leaves a settled done row alone when working repeats the same prompt', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'done',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeWorking('Fix the spinner')
    policy.onCommandCodeWorking('')

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('settles a still-working Command Code row to done after the settle window', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).toHaveBeenCalledWith(
      PANE_KEY,
      { state: 'done', prompt: 'Fix the spinner', agentType: 'command-code' },
      '✳ Build feature',
      undefined,
      ROUTING
    )
    policy.dispose()
  })

  it('abandons the done settle when another agent owns the row by then', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({ agentType: 'claude' })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    policy.dispose()
  })

  it('cancels a pending done settle when a working repaint arrives', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.onCommandCodeWorking('Fix the spinner')
    vi.advanceTimersByTime(DONE_SETTLE_MS * 2)

    const states = mockStoreState.setAgentStatus.mock.calls.map(([, payload]) => payload.state)
    expect(states).toEqual(['working'])
    policy.dispose()
  })

  it('dispose cancels a pending done settle', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry({
      state: 'working',
      prompt: 'Fix the spinner',
      agentType: 'command-code'
    })
    const policy = await createPolicy(PTY_ID_LOCAL)

    policy.onCommandCodeDone('Fix the spinner')
    policy.dispose()
    vi.advanceTimersByTime(DONE_SETTLE_MS * 2)

    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })

  it('nudges git UI on command finished for every PTY class', async () => {
    const local = await createPolicy(PTY_ID_LOCAL)
    local.onCommandFinished(0)
    local.dispose()
    const ssh = await createPolicy(PTY_ID_SSH)
    ssh.onCommandFinished(0)
    ssh.dispose()

    expect(dispatchTerminalCommandFinishedEvent).toHaveBeenCalledTimes(2)
    expect(dispatchTerminalCommandFinishedEvent).toHaveBeenCalledWith(WORKTREE_ID)
  })

  it('drops a same-turn status row on command finished for SSH PTYs only', async () => {
    mockStoreState.agentStatusByPaneKey[PANE_KEY] = makeStatusEntry()
    const local = await createPolicy(PTY_ID_LOCAL)
    local.onCommandFinished(0)
    // Why: local drops need the mounted pane's foreground process-confirm ladder
    // (leaked nested-shell 133;D protection), so the watcher must not drop them.
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    local.dispose()

    const ssh = await createPolicy(PTY_ID_SSH)
    ssh.onCommandFinished(0)
    expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(PANE_KEY)
    ssh.dispose()
  })

  it('clears the launch registry on SSH command finished when no status row exists', async () => {
    const ssh = await createPolicy(PTY_ID_SSH)

    ssh.onCommandFinished(0)

    expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(PANE_KEY)
    expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    ssh.dispose()
  })

  it('does nothing after dispose', async () => {
    const ssh = await createPolicy(PTY_ID_SSH)
    ssh.dispose()

    ssh.onCommandFinished(0)
    ssh.onCommandCodeWorking('Fix the spinner')

    expect(dispatchTerminalCommandFinishedEvent).not.toHaveBeenCalled()
    expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
  })
})
