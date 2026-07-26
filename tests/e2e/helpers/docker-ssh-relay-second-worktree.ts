import type { Page } from '@stablyai/playwright-test'

// Why: the retention-budget spec needs TWO remote worktrees on one connected
// target; connectDockerSshRelayTarget always mints a fresh target, so this
// replays only its addRemote+activate tail against an existing connection.
export async function addDockerSshRelayRemoteWorktree(
  page: Page,
  targetId: string,
  remotePath: string
): Promise<{ repoId: string; worktreeId: string }> {
  return page.evaluate(
    async ({ targetId, remotePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const result = await window.api.repos.addRemote({
        connectionId: targetId,
        remotePath,
        displayName: `Docker SSH Relay E2E ${remotePath}`
      })
      if ('error' in result) {
        throw new Error(result.error)
      }
      await store.getState().fetchRepos()
      await store.getState().fetchWorktrees(result.repo.id)
      const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? [])[0]
      if (!worktree) {
        throw new Error(`No remote worktree found for ${result.repo.path}`)
      }
      store.getState().setActiveWorktree(worktree.id)
      if ((store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
        store.getState().createTab(worktree.id)
      }
      store.getState().setActiveTabType('terminal')
      return { repoId: result.repo.id, worktreeId: worktree.id }
    },
    { targetId, remotePath }
  )
}
