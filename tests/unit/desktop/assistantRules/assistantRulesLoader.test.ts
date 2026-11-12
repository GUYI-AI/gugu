import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as policy from '@gugu/core/shared/assistantPolicy'
import { assistantExecutionAction } from '@gugu/core/shared/assistantWorkflow'
import { NEUTRAL_ASSISTANT_RULES } from './neutralRules'
import { ASSISTANT_RULES_TEXT_SLOTS, assistantRulesFiles, type AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { readAssistantProductRules, readDeclaredAssistantRules } from '../../../../apps/desktop/electron/assistant-product-rules'
import { assistantProfileReviewText } from '../../../../apps/desktop/electron/sessionpage/assistant-profile-review'
import { safeParseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { fingerprint, readNeutralDigests } from './capture'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-rules-app-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const MANIFEST = {
  id: 'gugu-assistant', name: 'Assistant', version: '0.0.1', apiVersion: 45, defaultLocale: 'en',
  platforms: ['desktop'], entry: 'index.html', contributes: { assistantRules: 'rules' },
}

/** A fixture App whose rules folder is generated from the neutral test rules (the product's words are not in this repository). */
async function fixtureApp(files = assistantRulesFiles(NEUTRAL_ASSISTANT_RULES)): Promise<string> {
  await writeFile(join(root, 'manifest.json'), JSON.stringify(MANIFEST))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Assistant</title>')
  await mkdir(join(root, 'rules'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, 'rules', name), content)
  return join(root, 'rules')
}

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

/** Every render the host's typed accessors produce from a set of rules, keyed as in the recorded digests where the key exists there. */
function renderThrough(rules: AssistantProductRules): Record<string, string> {
  const out: Record<string, string> = {}
  out['defaults/childHarness'] = rules.defaults.childHarness
  out['defaults/defaultModel'] = rules.defaults.defaultModel
  out['defaults/deniedTools'] = JSON.stringify(rules.defaults.deniedTools)
  out['defaults/profileRulesVersion'] = JSON.stringify(rules.defaults.profileRulesVersion)
  out['text/firstTask'] = rules.texts['first-task']
  out['text/taskExecution'] = rules.texts['task-execution']
  out['text/ownerProfileMemoryName'] = rules.labels.ownerProfileMemoryName
  out['text/ownerProfileIndexLine'] = policy.ownerProfileIndexLine(rules)
  out['dispatch/executorReport'] = rules.texts['executor-report']
  for (const kind of KINDS) {
    out[`guide/${kind}`] = policy.assistantGuide(kind, rules)
    HOMES.forEach((home, index) => { out[`brief/${kind}/${index}`] = policy.assistantBrief(kind, home.reference, home.memoryDir, rules) })
  }
  HOMES.forEach((home, index) => { out[`recovery/${index}`] = policy.assistantRecoveryContext(home.memoryDir, rules) })
  OWNERS.forEach((owner, index) => {
    const markdown = policy.ownerProfileMarkdown(owner, rules)
    out[`ownerProfile/markdown/${index}`] = markdown
    out[`ownerProfile/memoryFile/${index}`] = policy.ownerProfileMemoryFile(markdown, rules)
  })
  ;[null, '', '- [偏好](feedback.md) — 删东西前先问\n\n', '- [基本信息](owner-profile.md) — 已有'].forEach((index, at) => {
    out[`ownerProfile/index/${at}`] = policy.withOwnerProfileIndex(index, rules)
  })
  ;[null, '  ', '{"permissions":{"deny":["Bash(rm:*)"]},"model":"x"}', '{"permissions":{"deny":["CronCreate"]}}'].forEach((raw, at) => {
    out[`deniedTools/settings/${at}`] = policy.withDeniedTools(raw, rules.defaults.deniedTools)
  })
  ;[
    { action: 'spawn', prompt: '查一下日程', device: 'mac' },
    { action: 'message', text: '继续', to: ['session:a'] },
    { action: 'message', purpose: 'reply', text: '收到' },
    { action: 'message', text: `已有\n\n<gugu_task_context>\n${rules.texts['task-execution']}\n</gugu_task_context>` },
    { action: 'list' },
    'not an object',
  ].forEach((action, at) => {
    const wrapped = assistantExecutionAction(action, rules)
    out[`executionAction/${at}`] = typeof wrapped === 'string' ? wrapped : JSON.stringify(wrapped)
  })
  out['profileReview/outdated'] = assistantProfileReviewText(false, rules)
  out['profileReview/unreadable'] = assistantProfileReviewText(true, rules)
  out['loader/taskAgentIdentity'] = rules.texts['task-agent-identity']
  return out
}

describe('a fixture App generated from the neutral test rules', () => {
  it('is a valid App manifest declaring its rules folder', async () => {
    await fixtureApp()
    const parsed = safeParseExtensionManifest(MANIFEST)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.manifest.contributes.assistantRules).toBe('rules')
  })

  it('loads to exactly those rules and renders every accessor byte for byte as recorded', async () => {
    await fixtureApp()
    const loaded = await readDeclaredAssistantRules(root, MANIFEST as never)!
    expect(loaded).toEqual(NEUTRAL_ASSISTANT_RULES)
    expect(Object.isFrozen(loaded) && Object.isFrozen(loaded.texts)).toBe(true)

    const throughLoader = renderThrough(loaded)
    expect(throughLoader).toEqual(renderThrough(NEUTRAL_ASSISTANT_RULES))
    // And against the recorded renders of these rules (neutral-digests.json, written by the byte-identity test).
    const baseline = readNeutralDigests()
    const compared = Object.keys(throughLoader).filter(key => key in baseline)
    expect(compared.filter(key => fingerprint(throughLoader[key]!).sha256 !== baseline[key]!.sha256)).toEqual([])
    expect(compared).toHaveLength(Object.keys(throughLoader).length - 1)
    expect(compared).toHaveLength(39)
  })

  it('is not read for an App that declares no rules', () => {
    expect(readDeclaredAssistantRules(root, { contributes: { tabs: [] } } as never)).toBeNull()
  })
})

describe('the rules folder is refused unless it is exactly the format', () => {
  const built = () => assistantRulesFiles(NEUTRAL_ASSISTANT_RULES)
  const data = () => JSON.parse(built()['rules.json']!) as Record<string, unknown>
  const refuse = async (files: Record<string, string | Uint8Array>, code: string, message: RegExp) => {
    await writeFile(join(root, 'index.html'), '')
    await mkdir(join(root, 'rules'))
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, 'rules', name), content)
    await expect(readAssistantProductRules(root, 'rules')).rejects.toMatchObject({ name: 'AssistantRulesError', code, message: expect.stringMatching(message) })
  }

  it('names a newer data format instead of guessing at it', async () => {
    await refuse({ ...built(), 'rules.json': JSON.stringify({ ...data(), format: 2, extra: true }) }, 'unsupported-format', /rules\.json: is format 2; this host reads format 1/)
  })
  it('refuses an unknown key in rules.json', async () => {
    await refuse({ ...built(), 'rules.json': JSON.stringify({ ...data(), surprise: 1 }) }, 'invalid', /rules\.json/)
  })
  it('refuses a wrong default type', async () => {
    await refuse({ ...built(), 'rules.json': JSON.stringify({ ...data(), defaults: { ...(data().defaults as object), profileRulesVersion: '6' } }) }, 'invalid', /defaults\.profileRulesVersion/)
  })
  it('refuses a label that is not one line', async () => {
    await refuse({ ...built(), 'rules.json': JSON.stringify({ ...data(), labels: { ...(data().labels as object), ownerProfileMemoryName: 'a\nb' } }) }, 'invalid', /labels\.ownerProfileMemoryName/)
  })
  it.each([
    ['a line break', (intro: Record<string, Record<string, string>>) => ({ ...intro, 'zh-CN': { ...intro['zh-CN'], title: 'a\nb' } }), /intro\.zh-CN\.title/],
    ['a missing field', () => ({ 'en-US': { title: 'Hi' } }), /intro\.en-US/],
    ['a key that is no locale', (intro: Record<string, Record<string, string>>) => ({ '../x': intro['en-US'] }), /intro/],
  ])('refuses first-run introduction words with %s', async (_case, edit, message) => {
    await refuse({ ...built(), 'rules.json': JSON.stringify({ ...data(), intro: edit(data().intro as Record<string, Record<string, string>>) }) }, 'invalid', message)
  })
  it('reads a folder without first-run introduction words (written before the host read them) as having none', async () => {
    const { intro: _intro, ...older } = data()
    await writeFile(join(root, 'index.html'), '')
    await mkdir(join(root, 'rules'))
    for (const [name, content] of Object.entries({ ...built(), 'rules.json': `${JSON.stringify(older, null, 2)}\n` })) await writeFile(join(root, 'rules', name), content)
    const loaded = await readAssistantProductRules(root, 'rules')
    expect(loaded.intro).toBeUndefined()
    expect(assistantRulesFiles(loaded)['rules.json']).toBe(`${JSON.stringify(older, null, 2)}\n`)
  })
  it('refuses a missing file', async () => {
    const { 'first-task.md': _, ...without } = built()
    await refuse(without, 'invalid', /first-task\.md: is missing/)
  })
  it('refuses a file that is not part of the format', async () => {
    await refuse({ ...built(), 'notes.md': 'x\n' }, 'invalid', /notes\.md: is not part of format 1/)
  })
  it('refuses a slot its text may not use', async () => {
    await refuse({ ...built(), 'first-task.md': '读 {{memoryIndex}}\n' }, 'invalid', /first-task\.md: the text names \{\{memoryIndex\}\}/)
  })
  it('refuses an empty text', async () => {
    await refuse({ ...built(), 'recovery.md': '\n' }, 'invalid', /recovery\.md: is empty/)
  })
  it('refuses invalid UTF-8', async () => {
    await refuse({ ...built(), 'recovery.md': new Uint8Array([0xe4, 0xbd, 0x0a]) }, 'encoding', /recovery\.md: is not valid UTF-8/)
  })
  it('refuses a byte-order mark', async () => {
    await refuse({ ...built(), 'recovery.md': '\uFEFFtext\n' }, 'encoding', /byte-order mark/)
  })
  it('refuses a carriage return', async () => {
    await refuse({ ...built(), 'recovery.md': 'text\r\n' }, 'encoding', /carriage return/)
  })
  it('refuses a text over its size bound', async () => {
    await refuse({ ...built(), 'guide-cloud.md': `${'x'.repeat(64 * 1024 + 1)}\n` }, 'too-large', /guide-cloud\.md: is \d+ bytes; at most 65536/)
  })
  it('refuses a rules folder or file outside the bundle', async () => {
    await expect(readAssistantProductRules(root, '../elsewhere')).rejects.toMatchObject({ code: 'escape' })
    const outside = await mkdtemp(join(tmpdir(), 'assistant-rules-outside-'))
    try {
      for (const [name, content] of Object.entries(built())) await writeFile(join(outside, name), content)
      await symlink(outside, join(root, 'rules'))
      await expect(readAssistantProductRules(root, 'rules')).rejects.toMatchObject({ code: 'escape' })
      await rm(join(root, 'rules'))
      await mkdir(join(root, 'rules'))
      for (const [name, content] of Object.entries(built())) if (name !== 'recovery.md') await writeFile(join(root, 'rules', name), content)
      await symlink(join(outside, 'recovery.md'), join(root, 'rules', 'recovery.md'))
      await expect(readAssistantProductRules(root, 'rules')).rejects.toMatchObject({ code: 'escape', message: expect.stringMatching(/recovery\.md: must be a regular file/) })
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('covers every text key with its own file', () => {
    expect(Object.keys(built()).sort()).toEqual(['rules.json', ...Object.keys(ASSISTANT_RULES_TEXT_SLOTS).map(key => `${key}.md`)].sort())
  })
})

describe('the manifest contribution', () => {
  it('needs apiVersion 45', () => {
    const parsed = safeParseExtensionManifest({ ...MANIFEST, apiVersion: 40 })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.join('\n')).toMatch(/assistantRules requires apiVersion 45/)
  })
  it('must stay inside the bundle', () => {
    const parsed = safeParseExtensionManifest({ ...MANIFEST, contributes: { assistantRules: '../rules' } })
    expect(parsed.ok).toBe(false)
  })
})
