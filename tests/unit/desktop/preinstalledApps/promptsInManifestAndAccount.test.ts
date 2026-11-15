// Prompts (owner 11-07): an App offers plain-text prompts in its manifest (`contributes.prompts`, API 34), and the person's
// own live in one account row (prompt-library.ts).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { localizedPromptText } from '../../../../apps/desktop/src/session/shared/extensions/catalog'
import { parseExtensionManifest, safeParseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { APP_PROMPT_ACTIONS, editCloudPrompts, readCloudPrompts, withOverrides, type PromptLibraryPrompt } from '../../../../apps/desktop/src/session/shared/prompt-library'

const raw = JSON.parse(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/manifest.json'), 'utf8'))

describe('an App\'s prompts', () => {
  test('the folder App offers 群文件整理 in both languages', () => {
    const manifest = parseExtensionManifest(raw)
    const [prompt] = manifest.contributes.prompts!
    expect(localizedPromptText(manifest, prompt, 'zh-CN').title).toBe('群文件整理')
    expect(localizedPromptText(manifest, prompt, 'en-US').title).toBe('Tidy up the chat folder')
    expect(localizedPromptText(manifest, prompt, 'en-US').prompt).toContain('workspace__list')
  })

  test('prompts need API 34, and a translation names a prompt the App has', () => {
    expect(safeParseExtensionManifest({ ...raw, apiVersion: 33 }).ok).toBe(false)
    const typo = { ...raw, localized: { en: { ...raw.localized.en, prompts: { 'tidy-folders': { title: 'Tidy' } } } } }
    const result = safeParseExtensionManifest(typo)
    expect(result.ok ? [] : result.issues.join('\n')).toContain('no prompt named tidy-folders')
  })
})

/** One user_settings row in memory, versioned by updated_at as the table is (updateUserSettingsConfig). */
function settingsTable(config: Record<string, unknown>) {
  let row = { scope: 'prompts', config, updated_at: '2026-11-01T00:00:00.000Z' }
  const read = () => ({ maybeSingle: async () => ({ data: row, error: null }) })
  const client = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: read }) }),
      update: (values: typeof row) => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => {
        row = { ...values, scope: 'prompts' }
        return { data: row, error: null }
      } }) }) }) }) }),
    }),
  }
  return { client: client as never, row: () => row }
}

const fail = (message: string) => { throw new Error(message) }

describe('the person\'s prompts', () => {
  const prompt = (id: string): PromptLibraryPrompt => ({ id, title: id, prompt: `${id} text` })

  test('an edit is applied to the latest row and saved whole', async () => {
    const table = settingsTable({ items: [prompt('a'), prompt('b')] })
    const saved = await editCloudPrompts(table.client, 'u1', (all) => ({ ...all, items: [...all.items.filter((item) => item.id !== 'a'), prompt('c')] }), fail)
    expect(saved.items.map((item) => item.id)).toEqual(['b', 'c'])
    expect(table.row().config).toEqual(saved)
  })
})

describe('the person\'s version of an App\'s prompt (owner 11-08)', () => {
  const offered = (text: string) => [
    { key: 'workspace/tidy-folder', title: '群文件整理', prompt: text },
    { key: 'workspace/other', title: 'Other', prompt: 'other' },
  ]

  test('edited and hidden ones are the person\'s; restoring the default is removing the override', async () => {
    const table = settingsTable({ items: [] })
    let { overrides } = await editCloudPrompts(table.client, 'u1', (all) => ({ ...all, overrides: {
      'workspace/tidy-folder': { title: '整理', prompt: 'mine' }, 'workspace/other': { hidden: true } } }), fail)
    expect(withOverrides(offered('v1'), overrides).map(({ title, prompt, state }) => [title, prompt, state]))
      .toEqual([['整理', 'mine', 'modified'], ['Other', 'other', 'hidden']])
    ;({ overrides } = await editCloudPrompts(table.client, 'u1', (all) => ({ ...all, overrides: {} }), fail))
    expect(withOverrides(offered('v1'), overrides).map(({ prompt, state }) => [prompt, state])).toEqual([['v1', 'default'], ['other', 'default']])
  })

  test('an App update reaches what the person never touched, not what they edited', () => {
    const overrides = { 'workspace/other': { title: 'Mine', prompt: 'kept' } }
    expect(withOverrides(offered('v2'), overrides).map(({ prompt }) => prompt)).toEqual(['v2', 'kept'])
  })
})

describe('a broken override is dropped alone', () => {
  test('said in the log by key; a newer client\'s extra field is kept; the rest stays readable and writable', async () => {
    const table = settingsTable({ items: [{ id: 'a', title: 'a', prompt: 'a text' }], overrides: {
      'workspace/bad': { title: 1 }, 'workspace/newer': { hidden: true, since: 'v9' } } })
    const warned: string[] = []
    const read = await readCloudPrompts(table.client, 'u1', (message) => warned.push(message))
    expect(read.items.map((item) => item.id)).toEqual(['a'])
    expect(read.overrides).toEqual({ 'workspace/newer': { hidden: true, since: 'v9' } })
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('workspace/bad')
    const saved = await editCloudPrompts(table.client, 'u1', (all) => ({ ...all, items: [] }), () => {})
    expect(saved).toEqual({ items: [], overrides: { 'workspace/newer': { hidden: true, since: 'v9' } } })
    // Editing another prompt writes the unreadable one back as it was: a newer client's override is not lost.
    expect(table.row().config.overrides).toEqual({ 'workspace/bad': { title: 1 }, 'workspace/newer': { hidden: true, since: 'v9' } })
  })

  test('a hidden App prompt is only restored: editing it would make it 「已修改」', () => {
    expect(APP_PROMPT_ACTIONS.hidden).toEqual(['restore'])
    expect(APP_PROMPT_ACTIONS.modified).toContain('edit')
  })
})
