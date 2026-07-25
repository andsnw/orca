import type { TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, getActiveTabId } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PARKING_DELAY_MS = Number(process.env.ORCA_E2E_TERMINAL_PARKING_DELAY_MS) || 500

test.use({ seedTestRepo: false })

// C1 slice A: SSH tabs park like local ones and reveal restores content from
// main's headless model (relay replay is the fallback). This is the SSH
// park+reveal round-trip fidelity check the design gate required.
test.describe('SSH terminal hidden view parking', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH parking uses POSIX SSH tooling.')

  test('parks a hidden SSH tab and restores its scrollback on reveal', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(240_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const sshPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const sshTabId = await getActiveTabId(orcaPage)
      if (!sshTabId) {
        throw new Error('SSH terminal tab did not become active')
      }
      const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(snapshot.panes[0]?.ptyId).toBe(sshPtyId)

      // Why numbered lines: the reveal assertion checks BOTH the final marker
      // (screen) and an early line (scrollback depth beyond one viewport).
      const marker = `SSH_PARK_MARKER_${Date.now()}`
      await sendToTerminal(
        orcaPage,
        sshPtyId,
        `for i in $(seq 1 200); do echo "${marker}_$i"; done\r`
      )
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 30_000,
          message: 'SSH marker output did not render before parking'
        })
        .toContain(`${marker}_200`)

      await parkHiddenTabBehindDecoy(orcaPage, remote.worktreeId, sshTabId, {
        parkDelayMs: PARKING_DELAY_MS
      })

      // Reveal: reattach must paint from main's headless model (or relay
      // replay when the model is unavailable) — never a blank pane.
      await orcaPage.evaluate((tabId) => {
        const state = window.__store?.getState()
        state?.setActiveTab(tabId)
        state?.setActiveTabType('terminal')
      }, sshTabId)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await expect
        .poll(() => getTerminalContent(orcaPage, 20_000), {
          timeout: 60_000,
          message: 'revealed SSH tab did not restore the final marker line'
        })
        .toContain(`${marker}_200`)
      // Why _150 not _1: the relay-replay fallback is a 100KiB tail, so the
      // earliest lines are only guaranteed under the main-model paint; a mid
      // marker asserts multi-viewport depth without coupling to either source.
      await expect
        .poll(() => getTerminalContent(orcaPage, 40_000), {
          timeout: 15_000,
          message: 'revealed SSH tab lost scrollback beyond the visible screen'
        })
        .toContain(`${marker}_150`)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
