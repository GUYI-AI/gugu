// The read points of the assistant's product rules (#1931) — session start, each turn, dispatch, setup — each take one
// snapshot from the resolver per render, so a new version that swaps in meanwhile is never mixed into what they render.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installAssistantRulesResolver, type ResolvedAssistantRules } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { prepareLocalAssistantHome } from '../../../../apps/desktop/electron/assistant-home-prepare'
import { assistantHomeTaskContext, preparePersonalAssistantContext } from '../../../../apps/desktop/electron/sessionpage/assistant-context'
import { refreshAssistantContext } from '../../../../apps/desktop/electron/sessionpage/assistant-instructions'
import { prepareAssistantProfileReview } from '../../../../apps/desktop/electron/sessionpage/assistant-profile-review'
import { coordinateAssistantAction } from '../../../../apps/desktop/electron/sessionpage/assistant-work'
import { markedRules } from './fixtureApp'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-rules-read-points-')) })
afterEach(async () => {
  installAssistantRulesResolver(null)
  await rm(root, { recursive: true, force: true })
})

it('each read point asks once per render, so a swap during it cannot mix two versions', async () => {
  // A resolver whose answer changes after every question: a render that asked twice would carry both markers.
  const A = Object.freeze({ source: 'app', rules: markedRules('AAAMARK', '1.0.0'), appVersion: '1.0.0' }) as ResolvedAssistantRules
  const B = Object.freeze({ source: 'app', rules: markedRules('BBBMARK', '2.0.0'), appVersion: '2.0.0' }) as ResolvedAssistantRules
  let asked = 0
  const next = async () => (asked++ % 2 === 0 ? A : B)
  installAssistantRulesResolver({ refresh: next, current: next })
  const renders: Record<string, string> = {}

  const home = join(root, 'home'), guguHome = join(root, 'gugu'), cwd = join(guguHome, 'assistant')
  await mkdir(cwd, { recursive: true })
  asked = 0
  await refreshAssistantContext(cwd, guguHome, 'computer', home, 'claude')
  renders.handbook = [await readFile(join(cwd, 'CLAUDE.md'), 'utf8'), await readFile(join(cwd, '.gugu-assistant-reference.md'), 'utf8'),
    await readFile(join(cwd, '.claude', 'settings.json'), 'utf8')].join('\n')
  expect(asked).toBe(1)

  const memory = join(root, 'memory')
  await mkdir(memory, { recursive: true })
  await writeFile(join(memory, 'owner-profile.md'), '称呼：测试\n')
  asked = 0
  renders.review = (await prepareAssistantProfileReview({ text: 'hi', accepted: async () => {} }, memory)).beforeText ?? ''
  expect(asked).toBe(1)

  asked = 0
  let dispatched = ''
  await coordinateAssistantAction({ sessionId: 's', memoryDir: join(root, 'work') }, { action: 'spawn', prompt: 'p', device: 'mac' },
    async action => { dispatched = JSON.stringify(action); return { session_id: 'child' } })
  renders.dispatch = dispatched
  expect(asked).toBe(1)

  asked = 0
  const executor = await assistantHomeTaskContext({ report: {} as never, sessionPrompt: 'task', artifacts: [
    { path: '/caps/.claude-plugin/plugin.json', content: '{"name":"gugu-product"}', mode: 0o644 },
    { path: '/caps/.mcp.json', content: JSON.stringify({ mcpServers: { gugu: { type: 'http', url: 'u', headers: {} } } }), mode: 0o600 },
  ], sessionNewPatch: { meta: { claudeCode: { options: { plugins: [{ type: 'local', path: '/caps' }] } } } } }, cwd, guguHome)
  renders.executor = JSON.stringify(executor.sessionNewPatch)
  expect(asked).toBe(1)

  // A session start: the handbook it writes, the brief and the recovery notice in its prompt.
  const codexHome = join(root, 'codex-gugu'), codexCwd = join(codexHome, 'assistant')
  await mkdir(codexCwd, { recursive: true })
  asked = 0
  const started = await preparePersonalAssistantContext({ report: {} as never, sessionPrompt: 'platform', sessionNewPatch: { meta: {} } },
    codexCwd, codexHome, 'computer', { accountId: async () => 'owner', run: async (action: { action: string }) =>
      action.action === 'devices' || action.action === 'project_list' ? [] : action.action === 'device_actions' ? { devices: [] } : { items: [] } }, home, 'codex')
  renders.sessionStart = [started.sessionPrompt, await readFile(join(codexCwd, 'CLAUDE.md'), 'utf8'), await readFile(join(codexCwd, '.gugu-assistant-reference.md'), 'utf8')].join('\n')
  expect(asked).toBe(1)

  // Setup on this computer: the handbook and the profile memory.
  const setupHome = join(root, 'setup-home'), setupGugu = join(root, 'setup-gugu')
  await mkdir(setupHome, { recursive: true })
  asked = 0
  const { workdir } = await prepareLocalAssistantHome({ ownerProfile: '称呼：测试' }, { home: setupHome, guguHome: setupGugu })
  renders.setup = [await readFile(join(workdir, 'CLAUDE.md'), 'utf8'), await readFile(join(workdir, '.claude', 'memory', 'owner-profile.md'), 'utf8'),
    await readFile(join(workdir, '.claude', 'memory', 'MEMORY.md'), 'utf8')].join('\n')
  expect(asked).toBe(1)

  for (const [name, text] of Object.entries(renders)) {
    expect(text, name).toContain('AAAMARK')
    expect(text, name).not.toContain('BBBMARK')
  }
})
