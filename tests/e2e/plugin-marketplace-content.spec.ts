/**
 * Invariant: a fresh profile discovers the managed official marketplace and
 * completes the Phase 1 theme, language, and skill journey through production Git paths.
 */

import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'

const execFileAsync = promisify(execFile)

type MarketplaceFixture = {
  root: string
  home: string
  gitEnvironment: NodeJS.ProcessEnv
}

function isolatedGitProcessEnv(gitEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    ...gitEnvironment
  }
}

async function runGit(
  cwd: string,
  args: string[],
  gitEnvironment: NodeJS.ProcessEnv
): Promise<void> {
  await execFileAsync('git', args, { cwd, env: isolatedGitProcessEnv(gitEnvironment) })
}

async function commitRepository(
  repository: string,
  gitEnvironment: NodeJS.ProcessEnv
): Promise<void> {
  await runGit(repository, ['init', '--quiet'], gitEnvironment)
  await runGit(repository, ['checkout', '--quiet', '-b', 'main'], gitEnvironment)
  await runGit(repository, ['add', '--all'], gitEnvironment)
  await runGit(
    repository,
    [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=orca-test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture'
    ],
    gitEnvironment
  )
  await runGit(repository, ['tag', 'v1.0.0'], gitEnvironment)
}

async function copyLaunchPlugin(
  repositories: string,
  repositoryName: string,
  launchDirectory: string,
  gitEnvironment: NodeJS.ProcessEnv
): Promise<void> {
  const repository = join(repositories, `${repositoryName}.git`)
  await cp(join(process.cwd(), 'resources', 'plugins', 'launch', launchDirectory), repository, {
    recursive: true
  })
  await commitRepository(repository, gitEnvironment)
}

async function configureFixtureGit(home: string, repositories: string): Promise<NodeJS.ProcessEnv> {
  const hooksDirectory = join(home, 'hooks')
  const xdgConfigHome = join(home, 'xdg')
  const configPath = join(home, '.gitconfig')
  await Promise.all([
    mkdir(hooksDirectory, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true })
  ])
  const gitEnvironment: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  const repositoryBaseUrl = pathToFileURL(`${repositories}${sep}`).href
  const entries = [
    [`url.${repositoryBaseUrl}.insteadOf`, 'https://github.com/stablyai/'],
    ['protocol.file.allow', 'always'],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['core.hooksPath', hooksDirectory]
  ] as const
  for (const [key, value] of entries) {
    await runGit(home, ['config', '--file', configPath, key, value], gitEnvironment)
  }
  return gitEnvironment
}

async function createMarketplaceFixture(): Promise<MarketplaceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-e2e-'))
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(repositories, { recursive: true })
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories)
  await copyLaunchPlugin(
    repositories,
    'orca-nord-theme',
    'stablyai.orca-nord-theme',
    gitEnvironment
  )
  await copyLaunchPlugin(
    repositories,
    'orca-portuguese',
    'stablyai.orca-portuguese',
    gitEnvironment
  )

  const skillRepository = join(repositories, 'orca-e2e-skills.git')
  await cp(
    join(process.cwd(), 'resources', 'plugins', 'launch', 'stablyai.orca-workflow-skills'),
    skillRepository,
    { recursive: true }
  )
  const skillManifestPath = join(skillRepository, 'orca-plugin.json')
  const skillManifest = JSON.parse(await readFile(skillManifestPath, 'utf8')) as Record<
    string,
    unknown
  >
  skillManifest.id = 'orca-e2e-skills'
  skillManifest.name = 'Orca E2E Skills'
  skillManifest.repository = 'https://github.com/stablyai/orca-e2e-skills'
  await writeFile(skillManifestPath, `${JSON.stringify(skillManifest, null, 2)}\n`)
  await commitRepository(skillRepository, gitEnvironment)

  const marketplaceRepository = join(repositories, 'orca-plugins.git')
  await mkdir(marketplaceRepository, { recursive: true })
  await writeFile(
    join(marketplaceRepository, 'orca-marketplace.json'),
    `${JSON.stringify(
      {
        name: 'Orca Plugins',
        owner: 'stablyai',
        plugins: [
          ['stablyai.orca-nord-theme', 'orca-nord-theme', 'themes'],
          ['stablyai.orca-portuguese', 'orca-portuguese', 'languages'],
          ['stablyai.orca-e2e-skills', 'orca-e2e-skills', 'skills']
        ].map(([id, repository, category]) => ({
          id,
          source: {
            kind: 'git',
            url: `https://github.com/stablyai/${repository}.git`,
            ref: 'v1.0.0'
          },
          categories: [category]
        }))
      },
      null,
      2
    )}\n`
  )
  await commitRepository(marketplaceRepository, gitEnvironment)

  return {
    root,
    home,
    gitEnvironment
  }
}

async function openPluginSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'plugins', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function installMarketplacePluginThroughUi(
  page: Page,
  pluginKey: string,
  pluginName: string,
  expectedSkillCopy: readonly string[] = []
): Promise<void> {
  const listing = page.locator(`[data-marketplace-plugin-key="${pluginKey}"]`)
  await expect(listing).toBeVisible()
  await listing.getByRole('button', { name: 'Review' }).click()
  const preview = page.getByRole('dialog', { name: pluginName })
  await expect(preview).toContainText(pluginKey)
  await preview.getByRole('button', { name: 'Install plugin' }).click()
  const consent = page.getByRole('dialog', {
    name: expectedSkillCopy.length > 0 ? 'Review plugin content' : 'Review permissions'
  })
  await expect(consent).toBeVisible()
  for (const expected of expectedSkillCopy) {
    await expect(consent).toContainText(expected)
  }
  await consent.getByRole('button', { name: 'Enable plugin' }).click()
  await expect(consent).toBeHidden()
}

async function applyInstalledThemeAndLanguage(page: Page): Promise<void> {
  const themeId = 'plugin:stablyai.orca-nord-theme/nord'
  const languageId = 'plugin:stablyai.orca-portuguese/pt-BR'
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
  })
  await expect(page.locator('[data-settings-section="appearance"]')).toBeVisible()
  await page.getByRole('combobox', { name: 'Plugin theme' }).click()
  await page.getByRole('option', { name: 'Nord', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.orcaPluginTheme))
    .toBe(themeId)

  await page.evaluate(() => window.__store?.setState({ settingsSearchQuery: 'Language' }))
  await page.getByRole('combobox', { name: 'Language' }).click()
  await page.getByRole('option', { name: 'pt-BR — stablyai.orca-portuguese', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().settings?.uiLanguage))
    .toBe(languageId)
}

async function runMarketplaceJourney(page: Page, fixture: MarketplaceFixture): Promise<void> {
  const startedAt = Date.now()
  await openPluginSettings(page)
  const pluginSystem = page.getByRole('switch', { name: 'Plugin system' })
  await pluginSystem.click()
  await expect(pluginSystem).toBeChecked()
  await expect
    .poll(
      () =>
        page.evaluate(async () => ({
          sources: await window.api.plugins.listMarketplaces(),
          listings: await window.api.plugins.listMarketplacePlugins()
        })),
      { timeout: 30_000 }
    )
    .toMatchObject({
      sources: [expect.objectContaining({ official: true, stale: false })],
      listings: expect.arrayContaining([
        expect.objectContaining({ pluginKey: 'stablyai.orca-nord-theme', official: true }),
        expect.objectContaining({ pluginKey: 'stablyai.orca-portuguese', official: true }),
        expect.objectContaining({ pluginKey: 'stablyai.orca-e2e-skills', official: true })
      ])
    })

  await installMarketplacePluginThroughUi(page, 'stablyai.orca-nord-theme', 'Nord for Orca')
  await installMarketplacePluginThroughUi(page, 'stablyai.orca-portuguese', 'Português do Brasil')
  await installMarketplacePluginThroughUi(page, 'stablyai.orca-e2e-skills', 'Orca E2E Skills', [
    'change-handoff',
    'repository-review',
    'Record the branch, clean or dirty status'
  ])

  await applyInstalledThemeAndLanguage(page)
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.api.plugins.listSkillStore()).registrations.filter(
          (registration) => registration.pluginKey === 'stablyai.orca-e2e-skills'
        )
      )
    )
    .toHaveLength(2)

  const materializedPaths = await page.evaluate(async () =>
    (await window.api.plugins.listSkillStore()).registrations.flatMap((registration) =>
      registration.pluginKey === 'stablyai.orca-e2e-skills' ? registration.materializedPaths : []
    )
  )
  expect(materializedPaths.every((path) => path.startsWith(fixture.home))).toBe(true)
  expect(Date.now() - startedAt).toBeLessThan(120_000)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('installs and applies official Phase 1 content from a fresh profile', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const fixture = await createMarketplaceFixture()
  const session = createRestartSession(testInfo as TestInfo, {
    extraEnv: {
      ...fixture.gitEnvironment
    }
  })
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    await runMarketplaceJourney(launched.page, fixture)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
