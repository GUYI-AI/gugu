// @@@vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { claudeTuiSessionArgs, releaseClaudeTuiSettings } from '../../../../apps/desktop/electron/sessionpage/claude-tui-settings'
import { teardownSessionpageSessionRuntimes } from '../../../../apps/desktop/electron/sessionpage/sessionpage-session-runtime-registry'

const sessionId = 'fast-settings-fixture'
let dir = ''
afterEach(async () => {
  await releaseClaudeTuiSettings(sessionId)
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ''
})
const defaults = { sessionId, cwd: '/', baseArgs: [], extraArgs: [], userSettingsProvided: false, platformSettingsPath: null, fastMode: false }
const document = async (args: string[]) => {
  expect(args.filter(arg => arg === '--settings' || arg.startsWith('--settings='))).toHaveLength(1)
  const path = args[args.indexOf('--settings') + 1]
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  return { path, value: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> }
}

it.each([false, true])('keeps native base settings and explicit Fast %s in one document', async (fastMode) => {
  const args = await claudeTuiSessionArgs({ ...defaults, fastMode, baseArgs: ['--continue', '--settings', JSON.stringify({ fastMode })] })
  expect(args[0]).toBe('--continue')
  const actual = await document(args)
  expect(actual.value).toMatchObject({ disableAgentView: true, skipDangerousModePermissionPrompt: true, fastMode })
  await teardownSessionpageSessionRuntimes(sessionId)
  await expect(stat(actual.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('merges UltraCode and Fast without adding a second settings argument', async () => {
  const args = await claudeTuiSessionArgs({ ...defaults, fastMode: true, effort: 'ultracode', baseArgs: ['--settings', '{"fastMode":true,"ultracode":true}'] })
  expect((await document(args)).value).toMatchObject({ fastMode: true, ultracode: true, disableAgentView: true })
})

it('keeps the protected platform document and clamps Fast off without exposing credentials in argv', async () => {
  dir = await mkdtemp(join(tmpdir(), 'fast-platform-settings-'))
  const path = join(dir, 'settings.json')
  await writeFile(path, JSON.stringify({ model: 'gateway-model', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-only-secret' } }), { mode: 0o600 })
  const args = await claudeTuiSessionArgs({ ...defaults, fastMode: true, platformSettingsPath: path,
    baseArgs: ['--settings', '{"fastMode":true}'], extraArgs: ['--settings', path] })
  expect((await document(args)).value).toEqual({ model: 'gateway-model', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-only-secret' }, fastMode: false })
  expect(args.join(' ')).not.toContain('fixture-only-secret')
  await releaseClaudeTuiSettings(sessionId)
  expect((await stat(path)).isFile()).toBe(true)
})

it.each([false, true])('copies explicit user settings without modifying its source (equals=%s)', async (equals) => {
  dir = await mkdtemp(join(tmpdir(), 'fast-user-settings-'))
  const path = join(dir, 'settings.json'), original = '{"custom":42,"fastMode":true,"env":{"PRIVATE_KEY":"fixture-secret"}}'
  await writeFile(path, original)
  const args = await claudeTuiSessionArgs({ ...defaults, userSettingsProvided: true,
    baseArgs: equals ? [`--settings=${path}`] : ['--settings', path] })
  const actual = await document(args)
  expect(actual.path).not.toBe(path)
  expect(actual.value).toEqual({ custom: 42, fastMode: false, env: { PRIVATE_KEY: 'fixture-secret' } })
  expect(await readFile(path, 'utf8')).toBe(original)
  expect(args.join(' ')).not.toContain('fixture-secret')
})
