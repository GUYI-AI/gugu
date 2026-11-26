// @vitest-environment jsdom
// #7238: a pill to a markdown file's lines opens the 群文件夹 App there. Judged on the real app.js and the real CodeMirror
// (bound by a stand-in that puts the file's text in): a pill's link marks its lines in the source and the preview, found
// again when the file changed above them (and said), and only said when the lines themselves changed. A place is the
// file's it came for. (The App no longer cites a selection: a selection is commented on, in the host's comment box.)
// The preview is a stand-in that marks lines as gugu.markdown's `sourceLines` does (judged in markdown-entry.test.ts).
// Every wait is on a fact (until), not a clock.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { fingerprint } from '../../../../apps/desktop/preinstalled-apps/workspace/lines.js'
import { until } from '../../../support/awaitCondition'
import { documentToHtml } from '../../../../packages/session-chat-ui/src/core/markdown/to-html'

const TEXT = ['# 发布计划', '', '目标：十月上线', '负责人：小王', '', '## 风险', '- 支付接口可能延期', '', '- 甲：Api 文档，API 冻结', '- 乙'].join('\n')
const entry = {
  id: 'plan', chat: 'chat-1', name: 'plan.md', displayName: 'plan', contentType: 'text/markdown', type: 'text', size: 9,
  createdAt: null, updatedAt: null, createdBy: null, sourceMessageIds: [],
}
let changed: (event: { local: boolean; entry?: true }) => void = () => {}
let statusChanged: (status: string) => void = () => {}
const file = {
  entry,
  type: 'text',
  readOnly: false,
  status: 'online',
  saved: true,
  text: TEXT,
  onChange: vi.fn((handler: (event: { local: boolean; entry?: true }) => void) => {
    changed = handler
    return () => {}
  }),
  onStatus: vi.fn((handler: (status: string) => void) => {
    statusChanged = handler
    return () => {}
  }),
  close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
}

// One block per run of lines between blank lines, saying its lines (1-based) as `sourceLines` does — a run of list
// lines a list whose items say theirs too.
const md = {
  render: vi.fn((element: Element, text: string) => {
    if (text === SESSION_TEXT) {
      element.innerHTML = `<div class="gg-md">${documentToHtml(text, { trust: 'chat', sourceLines: true })}</div>`
      return
    }
    const blocks: string[] = []
    let start = 0
    const lines = text.split('\n')
    lines.forEach((line, i) => {
      if (line.trim() && (i === 0 || !lines[i - 1]!.trim())) start = i + 1
      if (!line.trim() || (i < lines.length - 1 && lines[i + 1]!.trim())) return
      const run = lines.slice(start - 1, i + 1)
      blocks.push(run.every((l) => l.startsWith('- '))
        ? `<ul data-line="${start}-${i + 1}">${run.map((l, k) => `<li data-line="${start + k}-${start + k}">${l.slice(2)}</li>`).join('')}</ul>`
        : `<p data-line="${start}-${i + 1}">${run.join(' ')}</p>`)
    })
    element.innerHTML = `<div class="gg-md">${blocks.join('')}</div>`
  }),
}
// A JSON file: shown as its indented text.
const config = {
  ...file, entry: { ...entry, id: 'cfg', name: 'cfg.json', contentType: 'application/json', type: 'json' }, type: 'json',
  toJSON: () => ({ a: '**粗**', b: '# 不是标题' }), onChange: () => () => {}, onStatus: () => () => {},
}
// Another markdown file, opened as itself (its text, when it is opened, as plan's).
// A chat's .txt, live text that is not markdown.
const notes = { ...file, entry: { ...entry, id: 'notes', name: 'notes.txt', contentType: 'text/plain' }, text: 'one\ntwo: the Blue Heron\nthree', onChange: () => () => {}, onStatus: () => () => {} }
const slowFile = () => ({ ...file, entry: { ...entry, id: 'slow', name: 'slow.md' }, text: file.text, onChange: () => () => {}, onStatus: () => () => {} })
const WS = 'session:11111111-1111-4111-8111-111111111111'
const sessionEntry = { ...entry, id: 'docs/proof.md', name: 'proof.md', chat: undefined, workspace: WS }
// A session's file, its preview drawn by the real markdown pipeline (soft line breaks and all).
const SESSION_TEXT = ['# 证明', '', '设 a 为偶数', '则 a² 为偶数', '', '- 引理一', '- 引理二'].join('\n')
const sessionFile = { ...file, entry: sessionEntry, text: SESSION_TEXT, onChange: () => () => {}, onStatus: () => () => {} }
// A session's code file: not a live document, read whole and shown as code.
const CODE = ['def is_bounded(seq, limit):', '    """__doc__: past N it stays near the limit."""', '    n = first_index_within(seq, limit, eps=1)', '    head = max(abs(x) for x in seq[:n])  # *the* head', '    return max(head, abs(limit) + 1)'].join('\n')
const codeEntry = { ...sessionEntry, id: 'src/bound.py', name: 'bound.py', contentType: 'text/x-python' }
const ctxOf = (id: string) => ({ chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'en', capabilities: ['files:read', 'files:write'],
  ...(id === sessionEntry.id || id === codeEntry.id ? { file: { workspace: WS, id }, workspace: { id: WS, sessionId: '11111111-1111-4111-8111-111111111111', root: '/project', name: 'Project' } } : { file: { chat: 'chat-1', id } }) })
let link: (event: { type: 'link'; tab: string; path: string; query: Record<string, string>; file: string | null }) => void = () => {}
let contextChanged: (ctx: ReturnType<typeof ctxOf>) => void = () => {}
const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ctxOf('plan')),
  onContextChanged: vi.fn((handler: typeof contextChanged) => {
    contextChanged = handler
    return () => {}
  }),
  onLink: vi.fn((handler: typeof link) => {
    link = handler
    return () => {}
  }),
  dispatch: vi.fn(async (_text: string, _options: unknown) => ({ to: { chat: 'g-1' } })),
  // The host's own kit: a code file's view needs all of it.
  codemirror: vi.fn(async () => (await import('../../../../apps/desktop/src/session/app-runtime/codemirror-entry')).codemirror),
  markdown: vi.fn(async () => md),
  // The file's text in the editor, as the binding puts it there.
  bind: {
    codemirror: vi.fn((view: EditorView, f: typeof file) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.text } })
      return () => {}
    }),
  },
  files: {
    // A working copy's unsaved edits kept on its machine (`gugu.files.draft`): none.
    draft: vi.fn(async () => null),
    readText: vi.fn(async () => ({ entry: codeEntry, content: CODE, exact: true })),
    viewPreferences: vi.fn(async () => ({ showAppData: false })), list: vi.fn(async () => [entry]), onChanged: vi.fn(() => () => {}), open: vi.fn(async (handle: { id: string }): Promise<unknown> => (handle.id === sessionEntry.id ? sessionFile : handle.id === 'cfg' ? config : handle.id === 'slow' ? slowFile() : handle.id === 'notes' ? notes : file)) },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!
const select = (...ranges: [number, number][]) => view().dispatch({ selection: EditorSelection.create(ranges.map(([from, to]) => EditorSelection.range(from, to))) })
const marked = (cls: string) => [...document.querySelectorAll('.cm-line')].flatMap((l, i) => (l.classList.contains(cls) ? [i + 1] : []))
const previewMarked = (cls: string) => [...document.querySelectorAll(`#preview .${cls}`)].map((b) => b.getAttribute('data-line'))
/** The editor's text changed by someone else: the file says so and the preview draws it again. */
async function edit(change: { from: number; to?: number; insert: string }) {
  view().dispatch({ changes: change })
  file.text = view().state.doc.toString()
  md.render.mockClear()
  changed({ local: false })
  await until('the preview is drawn again', () => md.render.mock.calls.length > 0)
}

beforeAll(async () => {
  // jsdom lays nothing out: a range has no boxes (the selection bar then has no place, as a hidden pane's).
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the file is in the editor', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === TEXT)
})

beforeEach(() => {
  gugu.dispatch.mockClear()
  select([0, 0])
  document.getSelection()?.removeAllRanges()
})

describe('a pill opens the file at its lines', () => {
  const pill = (lines: string, h: string) => link({ type: 'link', tab: 'main', path: '', query: { lines, h }, file: 'plan' })
  const h = fingerprint('目标：十月上线\n负责人：小王')

  test('marked in the source and the preview, until the next press on the file', () => {
    pill('3-4', h)
    expect(marked('cm-found')).toEqual([3, 4])
    expect(previewMarked('md-found')).toEqual(['3-4'])
    expect($('banner').hidden).toBe(true)
    $('editor').dispatchEvent(new Event('pointerdown'))
    expect(marked('cm-found')).toEqual([])
    expect(previewMarked('md-found')).toEqual([])
  })

  test('a list item: that item framed in the preview, not its whole list as well', () => {
    pill('10', fingerprint('- 乙'))
    expect(marked('cm-found')).toEqual([10])
    expect(previewMarked('md-found')).toEqual(['10-10'])
  })

  test('lines added above since: found where they are now, and said', async () => {
    await edit({ from: 0, insert: '新增一行\n\n' })
    pill('3-4', h)
    expect(marked('cm-found')).toEqual([5, 6])
    expect(previewMarked('md-found')).toEqual(['5-6'])
    expect($('banner').textContent).toBe('The cited lines moved: Lines 5–6')
    // Said until the next press: the file's status coming in (saved, as edits land) does not take it away (mac1 A/B
    // 10-15: the first status after a page opened hid it).
    statusChanged('online')
    expect($('banner').hidden).toBe(false)
    $('preview').dispatchEvent(new Event('pointerdown'))
    expect($('banner').hidden).toBe(true)
  })

  test('the lines themselves changed since: said, and nothing marked', async () => {
    const at = view().state.doc.toString().indexOf('小王')
    await edit({ from: at, to: at + 2, insert: '小李' })
    pill('3-4', h)
    expect(marked('cm-found')).toEqual([])
    expect($('banner').textContent).toBe('The cited lines changed since: this is where they were')
  })
})

describe("a link's find= opens the file at its words", () => {
  const find = (query: Record<string, string>) => link({ type: 'link', tab: 'main', path: '', query, file: 'plan' })
  const words = () => [...document.querySelectorAll('.cm-found-text')].map((w) => w.textContent).join('')

  test('the first place they stand: their line marked in the source and the preview, the words themselves too', () => {
    find({ find: '支付接口' })
    const at = marked('cm-found')
    expect(at).toHaveLength(1)
    expect(view().state.doc.line(at[0]!).text).toContain('支付接口')
    expect(words()).toBe('支付接口')
    expect(previewMarked('md-found')).toHaveLength(1)
    expect($('banner').hidden).toBe(true)
    $('editor').dispatchEvent(new Event('pointerdown'))
    expect(marked('cm-found')).toEqual([])
    expect(words()).toBe('')
  })

  test('in the preview, the words within their block are what the page highlights', () => {
    const ranges: Range[] = []
    Object.assign(globalThis.CSS ??= {} as typeof CSS, { highlights: { set: (_: string, h: { r: Range }) => ranges.push(h.r), delete: () => true } })
    Object.assign(globalThis, { Highlight: class { r: Range; constructor(r: Range) { this.r = r } } })
    try {
      find({ find: '十月上线' })
      expect(ranges.at(-1)?.toString()).toBe('十月上线')
      // As written before case aside, as the source finds them: both sides mark the same words.
      find({ find: 'API' })
      expect(words()).toBe('API')
      expect(ranges.at(-1)?.toString()).toBe('API')
    } finally {
      delete (globalThis.CSS as { highlights?: unknown }).highlights
    }
  })

  test('with lines too: found within those lines', () => {
    const text = view().state.doc.toString().split('\n')
    const listed = text.findIndex((l) => l === '- 乙') + 1
    find({ lines: `${listed}`, find: '- ' })
    expect(marked('cm-found')).toEqual([listed])
  })

  test('a .txt: its text alone, no markdown preview, found there', async () => {
    md.render.mockClear()
    contextChanged(ctxOf('notes'))
    await until('notes is in the editor', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === notes.text)
    link({ type: 'link', tab: 'main', path: '', query: { find: 'blue heron' }, file: 'notes' })
    expect(marked('cm-found')).toEqual([2])
    expect(words()).toBe('Blue Heron')
    expect(md.render).not.toHaveBeenCalled()
    expect(document.body.dataset.kind).toBe('json')
    contextChanged(ctxOf('plan'))
    await until('plan is in the editor again', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === file.text)
  })

  test('nowhere: said, and nothing marked', () => {
    find({ find: '没有这几个字' })
    expect(marked('cm-found')).toEqual([])
    expect(words()).toBe('')
    expect($('banner').textContent).toBe('Not found: “没有这几个字”')
    $('editor').dispatchEvent(new Event('pointerdown'))
    expect($('banner').hidden).toBe(true)
  })
})

describe("a pill's place is the file's it came for", () => {
  test('a place for a file still opening is not shown on the file opened next, even where its lines read the same', async () => {
    // A file slow to open (it never comes): the page is on it when its pill's place comes (#7232), then plan is opened.
    gugu.files.open.mockImplementationOnce(() => new Promise(() => {}))
    contextChanged(ctxOf('slow'))
    await until('the slow file is being opened', () => gugu.files.open.mock.calls.at(-1)?.[0].id === 'slow')
    // The slow file's place: its link names it (#7257 `file`).
    link({ type: 'link', tab: 'main', path: '', query: { lines: '1', h: fingerprint(file.text.split('\n')[0]!) }, file: 'slow' })
    contextChanged(ctxOf('plan'))
    await until('plan is in the editor again', () => document.querySelector('.cm-editor') !== null && view().state.doc.toString() === file.text)
    expect(marked('cm-found')).toEqual([])
    expect(previewMarked('md-found')).toEqual([])
    expect($('banner').hidden).toBe(true)
    // The slow file's place was dropped when plan began opening (#7257): the slow file, opened later, is drawn with
    // nothing marked.
    contextChanged(ctxOf('slow'))
    await until('the slow file is in the editor', () => $('doc-title').textContent === 'slow.md' && document.querySelector('.cm-editor') !== null && view().state.doc.toString() === file.text)
    expect(marked('cm-found')).toEqual([])
    expect($('banner').hidden).toBe(true)
    // A place whose link names another file is not shown on this one, though its line 1 reads the same.
    link({ type: 'link', tab: 'main', path: '', query: { lines: '1', h: fingerprint(file.text.split('\n')[0]!) }, file: 'elsewhere' })
    expect(marked('cm-found')).toEqual([])
  })
})
