// @vitest-environment jsdom
// A file handed to the Files App (opened from a card, a link, the folder's list) is drawn only once it is read — or once
// it is known why not: until then the page draws nothing (`body.reading`), so the host's loading mark stays and no empty
// page frame shows between it and the file. The tab is called by the file's name throughout: the page says no title of
// its own (the App's 文件 / Files) before the file is shown. Its own page (the folder's list) is drawn and titled at once.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const entry = {
  id: 'notes', name: 'fo-notes.md', displayName: 'fo-notes.md', contentType: 'text/markdown', type: 'text', size: 9, version: 1,
  createdAt: null, updatedAt: null, createdBy: { id: 'u1', name: 'A', kind: 'human' }, sourceMessageIds: [],
}
const textFile = () => ({
  entry, type: 'text', readOnly: false, status: 'online', saved: true, text: '# Notes\n',
  onChange: () => () => {}, onStatus: () => () => {}, onRefused: () => () => {}, close: vi.fn(),
  presence: { self: { userId: 'u2', color: '' }, others: [], onChange: () => () => {}, set: () => {} },
})
const chat = { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }

function deferred<T>() {
  let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void }
  const promise = new Promise<T>((resolve, reject) => { settle = { resolve, reject } })
  return { promise, ...settle }
}

let opened: ReturnType<typeof deferred<ReturnType<typeof textFile>>>
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://notes'),
  setTabTitle: vi.fn(async (_title: string) => {}),
  getContext: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  // The source editor is not what this measures; it never arrives here.
  codemirror: vi.fn(() => new Promise(() => {})),
  markdown: vi.fn(async () => ({ render: (element: HTMLElement, text: string) => { element.textContent = text } })),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async () => [entry]),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(() => opened.promise),
  },
}

const reading = () => document.body.classList.contains('reading')
const titles = () => gugu.setTabTitle.mock.calls.map(([title]) => title)

async function startPage(context: Record<string, unknown>) {
  // The page as its document gives it: the body's own attributes too (`reading` is on it before any script runs).
  const page = new DOMParser().parseFromString(readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  for (const name of document.body.getAttributeNames()) document.body.removeAttribute(name)
  for (const { name, value } of page.body.attributes) document.body.setAttribute(name, value)
  document.body.innerHTML = page.body.innerHTML
  gugu.getContext.mockImplementation(async () => context)
  Object.assign(window, { gugu })
  Object.assign(globalThis, { gugu })
  vi.resetModules()
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
}

beforeEach(() => {
  opened = deferred()
  gugu.setTabTitle.mockClear()
  gugu.files.open.mockClear()
})

describe('a handed file: nothing drawn until it is read', () => {
  test('while it is read the page draws nothing and names nothing; read, it is drawn and named after the file', async () => {
    await startPage({ chat, file: { chat: 'chat-1', id: 'notes' }, locale: 'en', capabilities: ['files:read'] })
    await until('the file is being read', () => gugu.files.open.mock.calls.length === 1)
    expect(reading()).toBe(true)
    expect(titles()).toEqual([])
    opened.resolve(textFile())
    await until('the file is drawn', () => !reading())
    expect(document.getElementById('preview')?.textContent).toContain('# Notes')
    expect(titles()).toEqual(['fo-notes.md'])
  })

  test('a file that cannot be read: its failure is what is drawn, the page no longer held back', async () => {
    await startPage({ chat, file: { chat: 'chat-1', id: 'notes' }, locale: 'en', capabilities: ['files:read'] })
    await until('the file is being read', () => gugu.files.open.mock.calls.length === 1)
    expect(reading()).toBe(true)
    opened.reject(Object.assign(new Error('gone'), { code: 'not-found' }))
    await until('the failure is drawn', () => !reading())
    expect(document.body.dataset.state).toBe('message')
    expect(document.getElementById('doc-message')?.textContent).not.toBe('')
    expect(titles()).toEqual([])
  })
})

describe('the App\'s own page', () => {
  test('the folder\'s list is drawn and titled with the App\'s name at once', async () => {
    await startPage({ chat, locale: 'en', capabilities: ['files:read'] })
    await until('the list page is drawn', () => !reading())
    expect(titles()).toEqual(['Files'])
  })
})
