// 群文件夹 App 给 agent 的文件夹工具(群文件夹工具搬进 App,2026-10-11):
// list / create / edit / delete,经 catalog 叫 workspace__<tool>。每个工具只用 gugu.files 和 Node 自带的模块;
// 交来的群、交来的文件在网关按调用的 agent 本人核过,所以每个 chat_id / item_id 都必须标 format、标在顶层(方案 R5,
// PR-1 评审第 3 条)。程序的 gugu 换成假的,跑的是真的 tools.js / folder.mjs。父提交上没有 folder.mjs,这些格全红。
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HANDED_CHAT_FORMAT, handedIds } from '../../../../apps/desktop/electron/session/main/core/extensions/extension-programs'
import { expectedVersionOf, replacedSinceError } from '../../../../apps/desktop/src/session/shared/extensions/app-files-core'
import { savedFileName } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { guguLink, linkTargetOf } from '@gugu/core/shared/ui/guguLink'

const appDir = resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace')
type Tool = { description: string; inputSchema: { type: string; required?: string[]; properties: Record<string, Record<string, unknown>> }; run: (args: Record<string, unknown>, call?: { agent?: string }) => Promise<unknown> }
const tools = async () => (await import(/* @vite-ignore */ resolve(appDir, 'tools.js'))) as Record<string, Tool>

const CHAT = '33333333-3333-4333-8333-333333333333'
const DOC = '0d000000-0000-4000-8000-000000000001'
const SHEET = '0d000000-0000-4000-8000-000000000002'
const PDF = '0d000000-0000-4000-8000-000000000003'
const MESSAGE = '55555555-5555-4555-8555-555555555555'
const by = { id: 'user:22222222-2222-4222-8222-222222222222', name: 'Kip', kind: 'agent' }
const entry = (id: string, name: string, type: string, more: Record<string, unknown> = {}) => {
  const file = {
    id, chat: CHAT, name, type, contentType: type === 'json' ? 'application/json' : type === 'binary' ? 'application/pdf' : 'text/markdown',
    size: 10, version: 1, createdBy: by, updatedAt: '2026-10-11T00:00:00Z', sourceMessageIds: [], ...more,
  }
  return { ...file, savedName: savedFileName(file) }
}
const ENTRIES: ReturnType<typeof entry>[] = []
/** The agents calling, as the gateway stamps them (`_meta['gugu/agent']`); each saves under its own folder. */
const AGENT = 'user:0a000000-0000-4000-8000-0000000000a1'

let texts: Record<string, string>
const calls: unknown[][] = []
const closed: string[] = []
// As an App sees a refusal: its code and, where it says which one, `detail.reason` (bridge-protocol.ts `ErrorDetail`).
const coded = (code: string, message: string, reason?: string) => Object.assign(new Error(message), { code, ...(reason ? { detail: { reason } } : {}) })

function handle(id: string) {
  const e = ENTRIES.find((candidate) => candidate.id === id)
  if (!e) throw coded('not-found', 'No such file in a chat you are in')
  const close = () => closed.push(id)
  if (e.type === 'binary') return { entry: e, type: 'binary', blob: async () => new Blob([new Uint8Array([1, 2, 3])]), close }
  return {
    entry: e,
    type: e.type,
    get text() { return texts[id]! },
    edit(old: string, next: string) {
      calls.push(['edit', id, old, next])
      const at = texts[id]!.indexOf(old)
      if (at < 0) throw coded('content-changed', 'old is not in the file (it changed, or it does not match exactly)', 'old-not-found')
      if (texts[id]!.indexOf(old, at + 1) >= 0) throw coded('ambiguous', 'old matches more than once; include more context', 'old-matches-many')
      texts[id] = texts[id]!.slice(0, at) + next + texts[id]!.slice(at + old.length)
    },
    close,
  }
}

beforeEach(() => {
  ENTRIES.splice(0, ENTRIES.length, entry(DOC, 'notes [v2].md', 'text'), entry(SHEET, 'prices.json', 'json'), entry(PDF, 'deck.pdf', 'binary'))
  texts = { [DOC]: '# Notes\n\n## One\nfirst\n\n## Two\nsecond\n', [SHEET]: '{\n  "widget": 12\n}' }
  calls.length = 0
  closed.length = 0
  vi.stubGlobal('gugu', {
    linkTo: async (args: Record<string, unknown>) => guguLink(linkTargetOf(args, { id: 'workspace', contributes: { tabs: [{ name: 'main' }] } })),
    files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
      list: async (place: unknown) => (calls.push(['list', place]), ENTRIES),
      open: async (ref: { id: string }, options?: unknown) => (calls.push(['open', ref, options ?? {}]), handle(ref.id)),
      upload: async (place: unknown, file: File, options: unknown) => {
        calls.push(['upload', place, file.name, file.type, await file.text(), options])
        const binary = file.name.endsWith('.bin')
        return [entry('0d000000-0000-4000-8000-00000000000a', file.name, binary ? 'binary' : 'text', binary ? { contentType: 'application/octet-stream' } : {})]
      },
      // The folder decides a text file's format by its name, and refuses a name without a text suffix (gugu-supabase
      // workspace_document_type): here only that refusal, in its words, so the tool is seen handing it on.
      create: async (place: unknown, content: unknown, options: unknown) => {
        const { name, ...where } = place as { name: string }
        calls.push(['create', where, name, content, options])
        if (!/\.(md|json|html)$/.test(name)) throw coded('invalid', `「${name}」没有文本文件的后缀:文档的名字以它的类型结尾,如 .md、.txt、.json、.csv、.html`)
        return entry('0d000000-0000-4000-8000-00000000000a', name, name.endsWith('.json') ? 'json' : 'text')
      },
      rename: async (ref: unknown, name: string) => (calls.push(['rename', ref, name]), entry(DOC, name, 'text')),
      // The folder's own version check (app-files-core, #7174), its functions not a copy of them; the fake only knows
      // which version the file is at. In the order files.replace asks: a version first, then the kind of file.
      replace: async (ref: { id: string }, blob: Blob, options?: { expectedVersion?: number }) => {
        calls.push(['replace', ref, new Uint8Array(await blob.arrayBuffer()), options])
        const expected = expectedVersionOf(options?.expectedVersion)
        if (ref.id === DOC) throw coded('invalid', 'notes.md is a live text file: change it through files.open, it is never replaced', 'live-text-file')
        const pdf = ENTRIES.find((candidate) => candidate.id === PDF)!
        if (pdf.version !== expected) throw replacedSinceError(pdf.name, pdf.version, expected)
        pdf.version += 1
        return { ...pdf }
      },
      remove: async (ref: unknown) => calls.push(['remove', ref]),
    },
  })
})

describe('the folder\'s tools as tools.js gives them', () => {
  // R5 / PR-1 评审第 3 条:没标 format 的 chat_id / item_id 让程序退回人的身份(#6492 的泄漏形状)。标在顶层才算数。
  test('every chat_id is a handed chat and every item_id a handed file, on the tool\'s own parameters — never nested', async () => {
    const all = await tools()
    expect(Object.keys(all).sort()).toEqual(['create', 'delete', 'edit', 'list'])
    const nested = (schema: unknown): string[] => {
      if (!schema || typeof schema !== 'object') return []
      const props = (schema as { properties?: Record<string, unknown>; items?: unknown }).properties ?? {}
      return [
        ...Object.keys(props).filter((key) => key === 'chat_id' || key === 'item_id'),
        ...Object.values(props).flatMap(nested),
        ...nested((schema as { items?: unknown }).items),
      ]
    }
    for (const [name, tool] of Object.entries(all)) {
      const props = tool.inputSchema.properties
      expect(tool.inputSchema.type, name).toBe('object')
      expect('chat_id' in props || 'item_id' in props, `${name} names its chat or file`).toBe(true)
      if (props.chat_id) expect(props.chat_id, name).toMatchObject({ type: 'string', format: 'gugu-chat' })
      if (props.item_id) expect(props.item_id, name).toMatchObject({ type: 'string', format: 'gugu-file' })
      // edit and delete take item_id or item_ids (one of them, checked in run); every other tool requires its own.
      if (props.item_ids) expect(props.item_ids, name).toMatchObject({ type: 'array', items: { type: 'string', format: 'gugu-file' } })
      else expect(tool.inputSchema.required, name).toContain(props.chat_id ? 'chat_id' : 'item_id')
      for (const [key, value] of Object.entries(props)) expect(nested(value), `${name}.${key} hides a chat or a file inside`).toEqual([])
    }
  })

  test('list: newest first as the folder gives them, with counts, a window, names filtered, links whole', async () => {
    const { list } = await tools()
    const all = (await list!.run({ chat_id: CHAT })) as Record<string, unknown> & { items: Record<string, unknown>[] }
    expect(calls[0]).toEqual(['list', { chat: CHAT }])
    expect(all).toMatchObject({ chat_id: CHAT, documents: 2, files: 1, total: 3, rows: '1-3', next: null })
    expect(all.items[0]).toEqual({
      id: DOC, name: 'notes [v2].md', path: undefined, metadata: {}, type: 'text', size: 10, version: 1, by, updated_at: '2026-10-11T00:00:00Z',
      link: `[notes &#91;v2&#93;.md](gugu-file://${DOC})`,
    })
    expect(await list!.run({ chat_id: CHAT, rows: '2' })).toMatchObject({ total: 3, rows: '1-2', next: '3-4' })
    expect(await list!.run({ chat_id: CHAT, rows: '3-4' })).toMatchObject({ rows: '3-3', next: null })
    expect(((await list!.run({ chat_id: CHAT, kind: 'file' })) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([PDF])
    expect(((await list!.run({ chat_id: CHAT, kind: 'document', name: 'PRICE' })) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([SHEET])
    await expect(list!.run({ chat_id: CHAT, rows: 'all' })).rejects.toThrow(/rows takes "20" or "21-40"/)
  })

  // chat_id 的说明请 agent 给「the number people see」:agent 照着传 JSON 数字 211178(A/B 10-12)。那个数要在网关里变成
  // 文字 —— 交出、按 agent 本人核、换成群 id;在程序里才转,就绕开了核(PR-2 评审 605898b,#6492 的泄漏形状)。
  // 真的 handedIds + 这个 App 真的 schema;list 和 create 共用 folder.mjs 的 chatOf,只收文字。
  test('chat_id: the gateway hands a JSON number as its text, checked as the agent; the program takes text only, anything else refused saying what it takes', async () => {
    const { list, create } = await tools()
    for (const tool of [list!, create!]) {
      expect(handedIds(tool as never, { chat_id: 211178 }, HANDED_CHAT_FORMAT)).toEqual(['211178'])
      expect(handedIds(tool as never, { chat_id: '211178' }, HANDED_CHAT_FORMAT)).toEqual(['211178'])
      expect(handedIds(tool as never, { chat_id: CHAT }, HANDED_CHAT_FORMAT)).toEqual([CHAT])
      // Not a whole positive number: named nothing, handed nothing — the program's own check below refuses it.
      for (const bad of [1.5, -3, 0, Number.NaN, Number.MAX_SAFE_INTEGER + 2, true, null]) expect(handedIds(tool as never, { chat_id: bad }, HANDED_CHAT_FORMAT)).toEqual([])
    }
    // Text reaches the folder as given.
    await list!.run({ chat_id: '211178' })
    await create!.run({ chat_id: CHAT, title: 'n.md', content: 'x' })
    expect(calls.map((call) => call.slice(0, 2))).toEqual([['list', { chat: '211178' }], ['create', { chat: CHAT }]])
    // Not text — a number the gateway did not hand included — refused before the folder is asked.
    const refused = /^chat_id is a chat's id or the number people see \(its 咕咕号\), not /
    for (const bad of [211178, 1.5, -3, 0, Number.NaN, '', null, undefined, true, { chat: CHAT }]) {
      await expect(list!.run({ chat_id: bad })).rejects.toThrow(refused)
      await expect(create!.run({ chat_id: bad, title: 'n.md', content: 'x' })).rejects.toThrow(refused)
    }
    await expect(list!.run({ chat_id: -3 })).rejects.toThrow(/, not -3$/)
    expect(calls).toHaveLength(2)
  })

  test('create with content: a text file named with its format, made by the folder as it is named; its source messages', async () => {
    const { create } = await tools()
    const made = await create!.run({ chat_id: CHAT, title: '周报.md', content: '# 周报', source_message_ids: [`msg:${MESSAGE}`] })
    expect(calls.at(-1)).toEqual(['create', { chat: CHAT }, '周报.md', '# 周报', { sourceMessageIds: [MESSAGE] }])
    expect(made).toMatchObject({ created: { name: '周报.md', type: 'text' }, stored_as: expect.stringMatching(/^a text file/) })
    await create!.run({ chat_id: CHAT, title: 'state.json', content: '{"votes":{}}' })
    expect(calls.at(-1)?.slice(0, 4)).toEqual(['create', { chat: CHAT }, 'state.json', '{"votes":{}}'])
    // Never guessed: a title without its type is the folder's refusal, said as the folder said it.
    await expect(create!.run({ chat_id: CHAT, title: '周报', content: '# 周报' })).rejects.toThrow('「周报」没有文本文件的后缀')
    await expect(create!.run({ chat_id: CHAT, content: 'x' })).rejects.toThrow(/needs a title/)
    await expect(create!.run({ chat_id: CHAT, title: 'big.md', content: 'y'.repeat(1024 * 1024 + 1) })).rejects.toThrow(/over the 1 MiB/)
  })

  // 同时跑的 A/B(10-12、10-13)里,「种子只在文件名里、正文没有」只出现在参数叫 name 的这一臂(合计 9 比 1,全是 Codex);
  // 对照臂原生的 workspace_create_document 一直叫 title。参数名对齐它(148 10-13)。
  test('create names its file with title, as the native workspace_create_document did — never name', async () => {
    const { create } = await tools()
    const params = Object.keys(create!.inputSchema.properties)
    expect(params).toContain('title')
    expect(params).not.toContain('name')
  })

  test('edit: old → new on the open file, then closed; what the folder refused, said as the next step', async () => {
    const { edit } = await tools()
    expect(await edit!.run({ item_id: DOC, old: '## Two', new: '## Second' })).toEqual({ edited: DOC })
    expect(texts[DOC]).toContain('## Second\nsecond')
    expect(closed).toEqual([DOC])
    await expect(edit!.run({ item_id: DOC, old: '## Gone', new: 'x' })).rejects.toThrow(/changed since you downloaded it, or old does not match it exactly/)
    await expect(edit!.run({ item_id: DOC, old: '##', new: 'x' })).rejects.toThrow(/matches several places/)
    await expect(edit!.run({ item_id: DOC, old: 'x', new: 'x' })).rejects.toThrow(/the same: nothing to change/)
    await expect(edit!.run({ item_id: PDF, old: 'a', new: 'b' })).rejects.toThrow(/stored file: give its next version as path/)
    await expect(edit!.run({ item_id: DOC, old: 'a', new: 'b', name: 'c.md' })).rejects.toThrow(/edit takes one change/)
  })

  test('edit: name renames it; path with expected_version gives a stored file its next version — a text file is never replaced', async () => {
    const { edit } = await tools()
    expect(await edit!.run({ item_id: DOC, name: ' plan.md ' })).toMatchObject({ renamed: { id: DOC, name: 'plan.md' } })
    expect(calls.at(-1)).toEqual(['rename', { id: DOC }, 'plan.md'])
    const path = join(mkdtempSync(join(tmpdir(), 'folder-tools-')), 'deck-v2.pdf')
    writeFileSync(path, Buffer.from([9, 8, 7]))
    expect(await edit!.run({ item_id: PDF, path, expected_version: 1 })).toMatchObject({ replaced: PDF, version: 2 })
    expect(calls.at(-1)).toEqual(['replace', { id: PDF }, new Uint8Array([9, 8, 7]), { expectedVersion: 1 }])
    // A version as digits in a string (a bridge that sends every argument as text) is the same number.
    expect(await edit!.run({ item_id: PDF, path, expected_version: '2' })).toMatchObject({ replaced: PDF, version: 3 })
    await expect(edit!.run({ item_id: DOC, path, expected_version: 1 })).rejects.toThrow(/is a text file: change it with old and new/)
  })

  // 存成下一版要说清从哪一版改起(#7174):检查只在 files.replace 那一处 —— folder.mjs 原样交过去,只把它说的话换成 agent
  // 的话。没带版本那次 replace 真被调了(带着 undefined),拒的是文件夹的那一处。
  test('edit with path: no version, or one that is no number, is refused by the folder\'s one check and said as the next step; expected_version without path is refused here', async () => {
    const { edit } = await tools()
    const path = join(mkdtempSync(join(tmpdir(), 'folder-tools-')), 'deck-v2.pdf')
    writeFileSync(path, Buffer.from([9, 8, 7]))
    await expect(edit!.run({ item_id: PDF, path })).rejects.toThrow('edit with path needs expected_version: the version message_download_file gave for the file you changed')
    expect(calls.at(-1)).toEqual(['replace', { id: PDF }, new Uint8Array([9, 8, 7]), { expectedVersion: undefined }])
    for (const bad of ['v1', 1.5]) {
      await expect(edit!.run({ item_id: PDF, path, expected_version: bad })).rejects.toThrow(`expected_version is the version message_download_file gave, a whole number, not ${JSON.stringify(bad)}`)
    }
    expect(ENTRIES.find((candidate) => candidate.id === PDF)!.version).toBe(1)
    const asked = calls.length
    await expect(edit!.run({ item_id: DOC, old: 'first', new: 'one', expected_version: 1 })).rejects.toThrow(/expected_version goes with path/)
    await expect(edit!.run({ item_id: DOC, name: 'n.md', expected_version: 1 })).rejects.toThrow(/expected_version goes with path/)
    // expected_version and nothing else: what it goes with, not「edit takes one change」(评审 5afe7e6bc7).
    await expect(edit!.run({ item_id: PDF, expected_version: 1 })).rejects.toThrow(/^expected_version goes with path/)
    expect(calls).toHaveLength(asked)
  })

  test('delete: the file, by its id', async () => {
    const { delete: remove } = await tools()
    expect(await remove!.run({ item_id: PDF })).toEqual({ deleted: PDF })
    expect(calls.at(-1)).toEqual(['remove', { id: PDF }])
  })
})

// 子文件夹 (gugu-supabase 20261016012659): the tools take a folder and say where each file is. Every case here is red on
// the parent commit (no folder, no path, no mkdir/move).
describe('the tools and subfolders', () => {
  const BOX = '0d000000-0000-4000-8000-0000000000f1'
  beforeEach(() => {
    ENTRIES.splice(0, ENTRIES.length,
      entry(BOX, '合同', 'folder', { path: '合同', parentId: null }),
      entry(PDF, 'deck.pdf', 'binary', { path: '合同/deck.pdf', parentId: BOX }),
      entry(DOC, 'notes.md', 'text', { path: 'notes.md', parentId: null }))
    const files = (globalThis as unknown as { gugu: { files: Record<string, unknown> } }).gugu.files
    files.mkdir = async (target: { path: string }) => (calls.push(['mkdir', target]), entry(BOX, target.path.split('/').at(-1)!, 'folder', { path: target.path }))
    files.move = async (ref: { id: string }, to: { folder: string; name?: string }) => {
      calls.push(['move', ref, to])
      if (to.name === 'taken.md') throw coded('name-taken', 'workspace_name_taken: taken.md already exists in this folder')
      const path = [to.folder, to.name].filter(Boolean).join('/')
      return entry(ref.id, to.name ?? 'notes.md', 'text', { path })
    }
    files.open = async (ref: { id: string }, options?: unknown) => {
      calls.push(['open', ref, options ?? {}])
      if (ref.id === BOX) throw coded('invalid', '合同 is a folder: what is in it is listed with files.list({ chat, folder })', 'folder')
      return handle(ref.id)
    }
  })

  test('list says each path, counts folders, and with folder asks for that folder only', async () => {
    const { list } = await tools()
    const all = (await list.run({ chat_id: CHAT })) as { documents: number; files: number; folders: number; items: { path: string; type: string }[] }
    expect(all).toMatchObject({ documents: 1, files: 1, folders: 1 })
    expect(all.items.map((row) => [row.path, row.type])).toEqual([['合同', 'folder'], ['合同/deck.pdf', 'binary'], ['notes.md', 'text']])
    // A folder is listed and entered, never opened: no link to open it with; a file has one.
    expect((all.items as { type: string; link?: string }[]).map((row) => row.type === 'folder' ? 'link' in row : typeof row.link)).toEqual([false, 'string', 'string'])
    expect(calls.at(-1)).toEqual(['list', { chat: CHAT }])
    await list.run({ chat_id: CHAT, folder: '合同' })
    expect(calls.at(-1)).toEqual(['list', { chat: CHAT, folder: '合同' }])
    expect(((await list.run({ chat_id: CHAT, kind: 'folder' })) as { items: { name: string }[] }).items.map((row) => row.name)).toEqual(['合同'])
    await expect(list.run({ chat_id: CHAT, folder: 3 })).rejects.toThrow(/folder is a folder's path/)
  })

  test('create puts a file in a folder; folder alone makes the folder; folder alone with a title is refused', async () => {
    const { create } = await tools()
    await create.run({ chat_id: CHAT, folder: '合同/2026', title: 'plan.md', content: 'x' })
    expect(calls.at(-1)).toEqual(['create', { chat: CHAT, folder: '合同/2026' }, 'plan.md', 'x', { sourceMessageIds: [] }])
    expect(await create.run({ chat_id: CHAT, folder: '合同/2026' })).toEqual({ created: { id: BOX, name: '2026', path: '合同/2026', type: 'folder' } })
    expect(calls.at(-1)).toEqual(['mkdir', { chat: CHAT, path: '合同/2026' }])
    await expect(create.run({ chat_id: CHAT, folder: '合同/2026', title: 'plan.md' })).rejects.toThrow(/folder alone makes that folder/)
    // Control: neither content nor folder is refused, saying where a file from this computer goes.
    await expect(create.run({ chat_id: CHAT, title: 'plan.md' })).rejects.toThrow(/create takes content \(a new text file\), or folder alone.*message_send's file_path/)
  })

  test('edit\'s name with / moves it (a leading / to the top); a name the folder has is said in the agent\'s words', async () => {
    const { edit } = await tools()
    expect(await edit.run({ item_id: DOC, name: '合同/2026/notes.md' })).toMatchObject({ moved: { id: DOC, name: 'notes.md', path: '合同/2026/notes.md' } })
    expect(calls.at(-1)).toEqual(['move', { id: DOC }, { folder: '合同/2026', name: 'notes.md' }])
    await edit.run({ item_id: DOC, name: '/notes.md' })
    expect(calls.at(-1)).toEqual(['move', { id: DOC }, { folder: '', name: 'notes.md' }])
    // Ending in /: into that folder, its name kept (no name sent); / alone, the top.
    expect(await edit.run({ item_id: DOC, name: '合同/' })).toMatchObject({ moved: { id: DOC } })
    expect(calls.at(-1)).toEqual(['move', { id: DOC }, { folder: '合同' }])
    await edit.run({ item_id: DOC, name: '/' })
    expect(calls.at(-1)).toEqual(['move', { id: DOC }, { folder: '' }])
    await expect(edit.run({ item_id: DOC, name: '合同/taken.md' })).rejects.toThrow(/already has a file of that name/)
    // Control: a name without / renames in place, as before.
    await edit.run({ item_id: DOC, name: 'plain.md' })
    expect(calls.at(-1)).toEqual(['rename', { id: DOC }, 'plain.md'])
  })

  test('edit on a folder says to list it', async () => {
    const { edit } = await tools()
    await expect(edit.run({ item_id: BOX, old: 'a', new: 'b' })).rejects.toThrow(/is a folder: list it/)
  })
})

// ws-batch(owner 11-05 msg:7d3bb92c):一组 id 挪进同一个文件夹 / 一起删;list 一次存下整份筛选结果。
describe('several files at once: item_ids, and list save', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, at) => `0d000000-0000-4000-8000-${String(at).padStart(12, '0')}`)
  let files: Record<string, unknown>
  beforeEach(() => {
    files = (globalThis as unknown as { gugu: { files: Record<string, unknown> } }).gugu.files
    files.move = async (ref: { id: string }, to: { folder: string; name?: string }) => {
      calls.push(['move', ref, to])
      if (ref.id === ids(3)[2]) throw coded('name-taken', 'workspace_name_taken: already exists in this folder')
      return entry(ref.id, 'x.png', 'binary', { path: `${to.folder}/x.png` })
    }
  })

  test('edit item_ids with a name ending in / moves them one by one, stopping at the first refusal and saying where', async () => {
    const { edit } = await tools()
    const [a, b, c, d] = ids(4)
    expect(await edit.run({ item_ids: [a, b], name: '证据/2026-10-30/' })).toEqual({ moved: 2 })
    expect(calls).toEqual([['move', { id: a }, { folder: '证据/2026-10-30' }], ['move', { id: b }, { folder: '证据/2026-10-30' }]])
    calls.length = 0
    expect(await edit.run({ item_ids: [a, b, c, d], name: '证据/' })).toEqual({ moved: 2, stopped_at: { id: c, error: expect.stringMatching(/already has a file of that name/) } })
    expect(calls.map((call) => (call[1] as { id: string }).id)).toEqual([a, b, c])
  })

  test('item_ids: one of item_id or item_ids, at most 200, and in edit only with a folder name ending in /', async () => {
    const { edit, delete: remove } = await tools()
    for (const args of [{ item_ids: ids(2), name: '证据/x.png' }, { item_ids: ids(2), old: 'a', new: 'b' }, { item_ids: ids(2) }]) {
      await expect(edit.run(args)).rejects.toThrow(/item_ids goes with a name ending in \/ alone/)
    }
    await expect(edit.run({ item_id: DOC, item_ids: ids(1), name: '证据/' })).rejects.toThrow(/item_id \(one file\) or item_ids/)
    await expect(remove.run({})).rejects.toThrow(/item_id \(one file\) or item_ids/)
    await expect(edit.run({ item_ids: ids(201), name: '证据/' })).rejects.toThrow(/at most 200/)
    await expect(remove.run({ item_ids: [] })).rejects.toThrow(/at least one/)
    expect(calls).toEqual([])
  })

  test('delete item_ids asks once whether each may be deleted: one refused, none deleted and those named; else one by one', async () => {
    const { delete: remove } = await tools()
    const [a, b, c] = ids(3)
    const mine = new Set([a, c])
    files.canDelete = async (refs: { id: string }[]) => (calls.push(['canDelete', refs]), refs.map((ref) => mine.has(ref.id)))
    await expect(remove.run({ item_ids: [a, b, c] })).rejects.toThrow(new RegExp(`^nothing was deleted: you may not delete ${b} `))
    expect(calls).toEqual([['canDelete', [{ id: a }, { id: b }, { id: c }]]])
    calls.length = 0
    expect(await remove.run({ item_ids: [a, c] })).toEqual({ deleted: 2 })
    expect(calls).toEqual([['canDelete', [{ id: a }, { id: c }]], ['remove', { id: a }], ['remove', { id: c }]])
  })

  test('list save: every matching row, no window, as JSON in the agent\'s own folder on this computer; the answer is its path and count', async () => {
    const { list } = await tools()
    ENTRIES.splice(0, ENTRIES.length, ...ids(45).map((id, at) => entry(id, `shot-${at}.png`, 'binary')), entry(DOC, 'notes.md', 'text'))
    const answer = (await list.run({ chat_id: CHAT, kind: 'file', rows: '1-5', save: true }, { agent: AGENT })) as { total: number; saved_to: string }
    expect(answer).toEqual({ chat_id: CHAT, total: 45, saved_to: join(tmpdir(), 'gugu-workspace', AGENT.slice('user:'.length), CHAT, 'list.json') })
    const saved = JSON.parse(readFileSync(answer.saved_to, 'utf8')) as { id: string; by: unknown; updated_at: string }[]
    expect(saved.map((row) => row.id)).toEqual(ids(45))
    expect(saved[0]).toMatchObject({ by, updated_at: '2026-10-11T00:00:00Z' })
    await expect(list.run({ chat_id: CHAT, save: true })).rejects.toThrow(/^list: only an agent saves/)
  })
})
