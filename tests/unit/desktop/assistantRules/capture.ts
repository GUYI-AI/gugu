// Every string the assistant's product rules render, for representative inputs.
//
// baseline.json was written by this module against the rules files as they were on origin/dev 4205711b66, before the
// product text was split out of them (#1931). The byte-identity test renders the same inputs through the current code —
// with the neutral test rules, their last good copy, or the product's own folder when given — and compares.
// Only the host's entry points are used. Since the read points were switched (#1931) the rules come from the process's
// resolver, as in the host: the pure renderers get the snapshot it answers with, the host's own entry points (the handbook
// refresh, the profile review, the dispatch wrapper, the executor's context) ask it themselves.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as policy from '@gugu/core/shared/assistantPolicy'
import * as workflow from '@gugu/core/shared/assistantWorkflow'
import { GUGU_PLATFORM_BLOCK, personalAssistantPlatformPrompt } from '../../../../apps/desktop/electron/product-platform-prompt'
import { assistantRules } from '../../../../apps/desktop/electron/assistant-rules-resolver'
import { assistantHomeTaskContext, personalAssistantContext, refreshAssistantContext } from '../../../../apps/desktop/electron/sessionpage/assistant-context'
import { prepareAssistantProfileReview } from '../../../../apps/desktop/electron/sessionpage/assistant-profile-review'
import { coordinateAssistantAction } from '../../../../apps/desktop/electron/sessionpage/assistant-work'
import type { Materialization } from '../../../../apps/desktop/electron/capability-bundle'

const KINDS = ['cloud', 'computer'] as const
const HOMES = [
  { reference: '/w/assistant/.gugu-assistant-reference.md', memoryDir: '/w/assistant/.claude/memory' },
  { reference: '/home/wuying/proj/.gugu-assistant-reference.md', memoryDir: '/home/wuying/.claude/projects/-home-wuying-proj/memory/' },
]
const OWNERS = [
  { preferredName: ' 小明 ', about: '  研究员，正在做细胞实验。\n早上 9 点开工。 ', language: 'zh-CN' },
  { preferredName: 'Ann', about: '', language: 'en-US' },
  { preferredName: 'Ann', about: '   ', language: 'en-US' },
]

function capabilities(sessionPrompt: string): Materialization {
  return {
    report: {} as Materialization['report'],
    sessionPrompt,
    artifacts: [
      { path: '/caps/.claude-plugin/plugin.json', content: '{"name":"gugu-product"}', mode: 0o644 },
      { path: '/caps/.mcp.json', content: JSON.stringify({ mcpServers: { gugu: { type: 'http', url: '${URL}', headers: {} } } }), mode: 0o600 },
    ],
    sessionNewPatch: { meta: { claudeCode: { options: { plugins: [{ type: 'local', path: '/caps' }], env: { KEEP: 'yes', ENABLE_TOOL_SEARCH: 'true' } } } } },
  }
}

const claudeOptions = (materialization: Materialization) =>
  JSON.stringify((materialization.sessionNewPatch!.meta!.claudeCode as { options: unknown }).options)

/**
 * Where each capture is read in the host: one of the four read points of the assistant's product rules, or `host`, the
 * host's own mechanics, the same whatever the rules.
 */
export type ReadPoint = 'session-start' | 'per-turn' | 'dispatch' | 'setup' | 'host'

export function readPointOf(key: string): ReadPoint {
  if (/^(host\/|homePaths\/|platform\/|session\/claudeOptions\/)/.test(key)) return 'host'
  if (/^(profileReview\/|defaults\/profileRulesVersion$)/.test(key)) return 'per-turn'
  if (/^(executionAction\/|dispatch\/|session\/taskAgentOptions$|text\/taskExecution$)/.test(key)) return 'dispatch'
  if (/^(ownerProfile\/|text\/(firstTask|ownerProfileMemoryName|ownerProfileIndexLine)$|defaults\/(childHarness|defaultModel)$)/.test(key)) return 'setup'
  if (/^(guide\/|brief\/|recovery\/|upsert\/|deniedTools\/|refresh\/|defaults\/deniedTools$)/.test(key)) return 'session-start'
  throw new Error(`no read point for ${key}`)
}

export async function captureAssistantRenders(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const put = (key: string, value: unknown) => { out[key] = typeof value === 'string' ? value : JSON.stringify(value) }
  const { rules } = await assistantRules().available()

  // Product text and defaults, as their consumers read them.
  put('defaults/childHarness', rules.defaults.childHarness)
  put('defaults/defaultModel', rules.defaults.defaultModel)
  put('defaults/deniedTools', rules.defaults.deniedTools)
  put('defaults/profileRulesVersion', rules.defaults.profileRulesVersion)
  put('text/firstTask', rules.texts['first-task'])
  put('text/taskExecution', rules.texts['task-execution'])
  put('text/ownerProfileMemoryName', rules.labels.ownerProfileMemoryName)
  put('text/ownerProfileIndexLine', policy.ownerProfileIndexLine(rules))
  put('host/markers', [policy.ASSISTANT_GUIDE_BEGIN, policy.ASSISTANT_GUIDE_END, policy.LEGACY_ASSISTANT_GUIDE_BEGIN, policy.LEGACY_ASSISTANT_GUIDE_END])
  put('host/resourcesDirName', policy.ASSISTANT_RESOURCES_DIR_NAME)
  put('host/computerWorkdirName', policy.ASSISTANT_COMPUTER_WORKDIR_NAME)

  for (const kind of KINDS) {
    put(`guide/${kind}`, policy.assistantGuide(kind, rules))
    HOMES.forEach((home, index) => put(`brief/${kind}/${index}`, policy.assistantBrief(kind, home.reference, home.memoryDir, rules)))
    put(`homePaths/${kind}`, policy.assistantHomePaths('/home/me', '/home/me/gugu/assistant', kind))
  }
  HOMES.forEach((home, index) => put(`recovery/${index}`, policy.assistantRecoveryContext(home.memoryDir, rules)))
  OWNERS.forEach((owner, index) => {
    const markdown = policy.ownerProfileMarkdown(owner, rules)
    put(`ownerProfile/markdown/${index}`, markdown)
    put(`ownerProfile/memoryFile/${index}`, policy.ownerProfileMemoryFile(markdown, rules))
  })
  ;[null, '', '- [偏好](feedback.md) — 删东西前先问\n\n', '- [基本信息](owner-profile.md) — 已有'].forEach((index, at) =>
    put(`ownerProfile/index/${at}`, policy.withOwnerProfileIndex(index, rules)))
  ;[null, '  ', '{"permissions":{"deny":["Bash(rm:*)"]},"model":"x"}', '{"permissions":{"deny":["CronCreate"]}}'].forEach((raw, at) =>
    put(`deniedTools/settings/${at}`, policy.withDeniedTools(raw, rules.defaults.deniedTools)))
  const guide = policy.assistantGuide('computer', rules)
  ;[
    '',
    'my notes',
    `before\n${policy.ASSISTANT_GUIDE_BEGIN}\nold\n${policy.ASSISTANT_GUIDE_END}\nafter`,
    `${policy.LEGACY_ASSISTANT_GUIDE_BEGIN}\nold\n${policy.LEGACY_ASSISTANT_GUIDE_END}\nmine`,
    '# 你是谁\n旧的整份',
  ].forEach((old, at) => put(`upsert/${at}`, policy.upsertAssistantGuide(old, guide)))

  // Dispatch wrappers.
  ;[
    { action: 'spawn', prompt: '查一下日程', device: 'mac' },
    { action: 'message', text: '继续', to: ['session:a'] },
    { action: 'message', purpose: 'reply', text: '收到' },
    { action: 'message', text: `已有\n\n<gugu_task_context>\n${rules.texts['task-execution']}\n</gugu_task_context>` },
    { action: 'list' },
    'not an object',
  ].forEach((action, at) => put(`executionAction/${at}`, workflow.assistantExecutionAction(action, rules)))

  // Platform block: generic and the assistant's.
  put('platform/block', GUGU_PLATFORM_BLOCK)
  put('platform/assistant/alone', personalAssistantPlatformPrompt(GUGU_PLATFORM_BLOCK))
  put('platform/assistant/embedded', personalAssistantPlatformPrompt(`identity\n\n${GUGU_PLATFORM_BLOCK}\n\nproject`))
  put('platform/assistant/absent', personalAssistantPlatformPrompt('no platform block here'))

  // Session-start materialization (system prompt and SDK options) and the one-off executor sharing the directory.
  for (const kind of KINDS) put(`session/claudeOptions/${kind}`, claudeOptions(personalAssistantContext(capabilities(`identity\n\n${GUGU_PLATFORM_BLOCK}`), kind)))
  put('session/taskAgentOptions', claudeOptions(await assistantHomeTaskContext(capabilities('task prompt'), '/g/assistant', '/g')))

  const root = await mkdtemp(join(tmpdir(), 'assistant-rules-capture-'))
  // The temporary root also appears in Claude Code's project-folder form (non-alphanumerics as '-').
  const scrub = (text: string) => text.split(root).join('<ROOT>').split(policy.claudeProjectDirName(root)).join('<ROOT-DIR>')
  try {
    // What a session start writes into the assistant's home.
    for (const [name, kind, engine] of [['computer-claude', 'computer', 'claude'], ['computer-codex', 'computer', 'codex'], ['cloud-claude', 'cloud', 'claude']] as const) {
      const guguHome = join(root, name, 'gugu'), home = join(root, name, 'home'), cwd = kind === 'computer' ? join(guguHome, 'assistant') : join(home, 'proj')
      await mkdir(cwd, { recursive: true })
      await refreshAssistantContext(cwd, guguHome, kind, home, engine)
      const paths = policy.assistantHomePaths(home, cwd, kind)
      put(`refresh/${name}/instructions`, scrub(await readFile(paths.instructions, 'utf8')))
      put(`refresh/${name}/reference`, scrub(await readFile(join(cwd, '.gugu-assistant-reference.md'), 'utf8')))
      // claudeMdExcludes also lists every folder above the temporary root, which differs per machine: keep the part under it.
      const settings = scrub(await readFile(paths.settings, 'utf8').catch(() => '<absent>'))
      put(`refresh/${name}/settings`, settings === '<absent>' ? settings : (() => {
        const parsed = JSON.parse(settings) as { claudeMdExcludes?: string[] }
        return JSON.stringify({ ...parsed, claudeMdExcludes: parsed.claudeMdExcludes?.filter(path => path.startsWith('<ROOT>')) }, null, 2)
      })())
    }

    // The per-turn profile review: missing index, outdated version, unreadable index, current version.
    const admission = { text: 'hi', accepted: async () => {} }
    for (const [name, index] of [['missing', null], ['outdated', '- [关于你](owner-profile.md) — 事实；profile_rules: 2\n'], ['unreadable', 'dir'], ['current', `- [关于你](owner-profile.md) profile_rules: ${rules.defaults.profileRulesVersion}\n`]] as const) {
      const memory = join(root, 'review', name)
      await mkdir(memory, { recursive: true })
      await writeFile(join(memory, 'owner-profile.md'), '称呼：测试\n')
      if (index === 'dir') await mkdir(join(memory, 'MEMORY.md'))
      else if (index !== null) await writeFile(join(memory, 'MEMORY.md'), index)
      put(`profileReview/${name}`, (await prepareAssistantProfileReview(admission, memory)).beforeText ?? '<none>')
    }

    // The executor report wording attached to every assistant dispatch (work ids are random: only the report is kept).
    const memoryDir = join(root, 'work')
    let dispatched: Record<string, unknown> = {}
    await coordinateAssistantAction({ sessionId: 'assistant-session', memoryDir }, { action: 'spawn', prompt: '做一件事', device: 'mac' },
      async action => { dispatched = action as Record<string, unknown>; return { session_id: 'child' } })
    const work = /<gugu_work>\n(.*)\n<\/gugu_work>/.exec(String(dispatched.prompt))![1]!
    const parsed = JSON.parse(work) as Record<string, unknown>
    put('dispatch/executorReport', parsed.report)
    put('dispatch/shape', { keys: Object.keys(parsed), prompt: String(dispatched.prompt).replace(String(parsed.work_id), '<WORK>') })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  return out
}

export type Fingerprint = { bytes: number; sha256: string }

/** UTF-8 byte length and SHA-256 of a render: what baseline.json keeps for each capture. */
export function fingerprint(value: string): Fingerprint {
  const bytes = Buffer.from(value, 'utf8')
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export const BASELINE_URL = new URL('./baseline.json', import.meta.url)
/** The renders of the neutral test rules (neutralRules.ts), recorded by the byte-identity test. */
export const NEUTRAL_DIGESTS_URL = new URL('./neutral-digests.json', import.meta.url)
export const readNeutralDigests = () => JSON.parse(readFileSync(NEUTRAL_DIGESTS_URL, 'utf8')) as Record<string, Fingerprint>
export const readBaseline = () => JSON.parse(readFileSync(BASELINE_URL, 'utf8')) as Record<string, Fingerprint>
