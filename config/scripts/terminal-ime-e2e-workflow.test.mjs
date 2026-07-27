import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('terminal IME e2e workflow', () => {
  const workflow = parse(
    readFileSync(join(projectDir, '.github/workflows/terminal-ime-e2e.yml'), 'utf8')
  )

  it('runs for xterm patch and terminal IME regression changes', () => {
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        'config/patches/@xterm__xterm@6.1.0-beta.287.patch',
        'config/scripts/run-terminal-ibus-hangul-e2e.mjs',
        'src/renderer/src/components/terminal-pane/terminal-ime-*.ts',
        'tests/e2e/terminal-ibus-hangul-native.spec.ts',
        'tests/e2e/terminal-ime-*.ts'
      ])
    )
  })

  it('installs native IBus Hangul and X11 input tools', () => {
    const runs = workflow.jobs['linux-x11'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const installRun = runs.find((run) => run.includes('apt-get install'))

    expect(installRun).toContain('ibus-hangul')
    expect(installRun).toContain('xdotool')
    expect(installRun).toContain('xfwm4')
    expect(installRun).toContain('xvfb')
    expect(installRun).toContain('dbus-x11')
  })

  it('runs deterministic boundaries before the real IBus suite', () => {
    const runs = workflow.jobs['linux-x11'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const deterministicIndex = runs.findIndex((run) =>
      run.includes('terminal-ime-exact-byte.spec.ts')
    )
    const nativeIndex = runs.indexOf('pnpm run test:e2e:terminal-ime-native')

    expect(deterministicIndex).toBeGreaterThanOrEqual(0)
    expect(nativeIndex).toBeGreaterThan(deterministicIndex)
  })

  it('keeps IBus lifecycle scoped to owned processes', () => {
    const runner = readFileSync(
      join(projectDir, 'config/scripts/run-terminal-ibus-hangul-e2e.mjs'),
      'utf8'
    )

    expect(runner).toContain(
      "['--xim', '--verbose', '--panel=disable', '--emoji-extension=disable']"
    )
    expect(runner).toContain("spawn('xfwm4', ['--compositor=off']")
    expect(runner).toContain("['initial-input-mode', 'hangul']")
    expect(runner).toContain("['hangul-keyboard', '2']")
    expect(runner).toContain("process.kill(-processGroupId, 'SIGTERM')")
    expect(runner).not.toContain("'--replace'")
    expect(runner).not.toContain('killall')
    expect(runner).not.toContain('pkill')
  })
})
