// @vitest-environment jsdom
// 群文件夹的分块(owner 11-12):最上层放的文件和聊天附件(「附件」里的)各在自己的标题下;云端副本已到期清除的文件收进最底下
// 一个合着的「已过期 N」,点开才列出,每行标着「已过期」;没点开过的文件夹显示列表带来的项数,里面一有增减就重读它所在的那一层。
// 页面跑在假的 window.gugu 上。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest'
import { listedIn } from './folderList'
import { until } from '../../../support/awaitCondition'
import { fakeSharedMenu } from './sharedMenu'

const now = Date.parse('2026-11-12T12:00:00Z')
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
const entry = (id: string, name: string, more: Record<string, unknown> = {}) => ({
  id, name, displayName: name, contentType: 'application/pdf', type: 'binary', size: 1000, parentId: null, path: name, systemRole: null,
  version: 1, createdAt: ago(600), updatedAt: ago(600), createdBy: { id: 'u1', name: '张三', kind: 'human' }, sourceMessageIds: [], keep: null, ...more,
})
const ENTRIES = [
  entry('att', '附件', { type: 'folder', contentType: 'inode/directory', systemRole: 'attachments', size: null }),
  entry('docs', 'Docs', { type: 'folder', contentType: 'inode/directory', size: null, childCount: 4 }),
  entry('big', 'Big', { type: 'folder', contentType: 'inode/directory', size: null, childCount: 1000 }),
  entry('plan', 'plan.pdf'),
  entry('sent1', 'sent1.pdf', { parentId: 'att', path: '附件/sent1.pdf' }),
  entry('sent2', 'sent2.pdf', { parentId: 'att', path: '附件/sent2.pdf', updatedAt: ago(300) }),
  entry('gone', 'gone.pdf', { parentId: 'att', path: '附件/gone.pdf', expiredAt: ago(3600) }),
]

let filesChanged = (_change: { kind: 'entries'; entries: unknown[]; gone: string[] }) => {}
const menu = fakeSharedMenu()
const gugu = {
  showContextMenu: menu.showContextMenu,
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ({ chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] })),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  clipboard: { writeText: vi.fn(async () => {}) },
  files: {
    canDelete: vi.fn(async (files: unknown) => [files].flat().map(() => true)),
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place?: { folder?: string }) => listedIn(ENTRIES, place)),
    onChanged: vi.fn((_place: unknown, fn: typeof filesChanged) => { filesChanged = fn; return () => {} }),
    openWith: vi.fn(async () => {}),
    download: vi.fn(async () => true),
    keep: vi.fn(async () => {}),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const ids = () => [...$('file-list').querySelectorAll<HTMLElement>('li.file')].map((li) => li.dataset.id)
// Every heading of the list: a block's (#), its count after; one that folds says so (▸).
const headings = () => [...$('file-list').querySelectorAll<HTMLElement>('.list-section')].map((li) =>
  `${li.dataset.block ? '#' : ''}${li.querySelector('.section-toggle') ? '▸' : ''}${li.querySelector('.section-toggle > span')?.textContent ?? li.firstChild?.textContent} ${li.querySelector('.section-count')?.textContent ?? ''}`.trim())
const toggle = (key: string) => $('file-list').querySelector<HTMLElement>(`[data-block="${key}"] .section-toggle`)!

beforeAll(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  localStorage.clear()
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the list drawn', () => ids().length > 0)
})

afterAll(() => vi.restoreAllMocks())

describe('the top of a chat folder', () => {
  test('the files placed there and the ones sent in the chat are two blocks under a plain heading; only the expired one folds', () => {
    expect(headings()).toEqual(['文件夹', '#文件 1', '#聊天附件 2', '#▸已过期 1'])
    expect(ids()).toEqual(['big', 'docs', 'plan', 'sent2', 'sent1'])
    expect(toggle('expired').getAttribute('aria-expanded')).toBe('false')
  })

  test('a press opens the expired block: each row dimmed and marked, the day it went on hover', async () => {
    toggle('expired').click()
    await until('the expired rows drawn', () => ids().includes('gone'))
    expect(ids()).toEqual(['big', 'docs', 'plan', 'sent2', 'sent1', 'gone'])
    const row = document.querySelector<HTMLElement>('[data-id="gone"]')!
    expect(row.hasAttribute('data-expired')).toBe(true)
    const mark = row.querySelector<HTMLElement>('.file-keep[data-expired]')!
    expect(mark.textContent).toBe('已过期')
    expect(mark.title).toContain('到期')
    toggle('expired').click()
    await until('folded again', () => !ids().includes('gone'))
  })

  test('a folder not entered yet says the count its list came with', () => {
    expect(document.querySelector('[data-id="docs"] [data-cell="size"]')?.textContent).toBe('4 项')
    // The list counts up to 1000: 1000 means 1000 or more.
    expect(document.querySelector('[data-id="big"] [data-cell="size"]')?.textContent).toBe('999+ 项')
  })

  test('an item that comes into a folder not entered yet: the list that folder is in is read again, and its count follows', async () => {
    const note = entry('note', 'note.md', { parentId: 'docs', path: 'Docs/note.md', keep: null })
    ENTRIES.push(note)
    Object.assign(ENTRIES.find((e) => e.id === 'docs')!, { childCount: 5 })
    const reads = gugu.files.list.mock.calls.length
    filesChanged({ kind: 'entries', entries: [note], gone: [] })
    await until('Docs says 5', () => document.querySelector('[data-id="docs"] [data-cell="size"]')?.textContent === '5 项')
    expect(gugu.files.list.mock.calls.slice(reads).map(([place]) => (place as { folder?: string }).folder)).toEqual([''])
  })
})
