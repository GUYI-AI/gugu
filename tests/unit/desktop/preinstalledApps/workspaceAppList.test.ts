// @vitest-environment jsdom
// 群文件夹的列表(owner 10-28 定稿的第一步):按类型分段(全部 / 文档 / 图片和视频 / 其他)、排序(最近 / 名称 / 大小,
// 按最近时分今天 / 昨天 / 过去 7 天 / 每月)、行尾淡淡的「临时 · 还剩多久」和存在哪台机器,⋯ 里的「设为临时 / 持续保存」
// (只有自己传的、有云端副本的能改;不能改的说为什么,在悬停里)。页面跑在假的 window.gugu 上。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { listedIn } from './folderList'
import { until } from '../../../support/awaitCondition'
import { fakeSharedMenu } from './sharedMenu'

const now = Date.parse('2026-10-28T12:00:00Z')
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
const DAY = 86400
const file = (id: string, name: string, contentType: string, size: number, at: string, more: Record<string, unknown> = {}) => ({
  id, name, displayName: name, contentType, type: /^text\/|json/.test(contentType) ? 'text' : 'binary', size, parentId: null, path: name,
  systemRole: null, version: 1, createdAt: at, updatedAt: at, createdBy: { id: 'u1', name: '张三', kind: 'human' }, sourceMessageIds: [], canDelete: true, ...more,
})
const machine = { machine: 'R server', owner: '张三', mine: true }
const ENTRIES = [
  file('spec', 'spec.pdf', 'application/pdf', 1_200_000, ago(600), { keep: { expiresAt: new Date(now + 6 * DAY * 1000 + 3600_000).toISOString(), mine: true }, sourceMessageIds: ['m1'] }),
  file('clip', 'clip.mp4', 'video/mp4', 300_000, ago(1200), { keep: { expiresAt: new Date(now + 5 * 3600_000).toISOString(), mine: false } }),
  file('shot', 'shot.png', 'image/png', 3_000, ago(DAY + 60), { storedOn: machine, keep: null }),
  file('pack', 'pack.zip', 'application/zip', 20_000_000, ago(3 * DAY), { keep: { expiresAt: null, mine: true } }),
  file('notes', 'notes.md', 'text/markdown', 37, ago(40 * DAY), { keep: null }),
]

const context = { chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
const menu = fakeSharedMenu()
const gugu = {
  showContextMenu: menu.showContextMenu,
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  clipboard: { writeText: vi.fn(async () => {}) },
  files: {
    // Asked as a row's menu opens (a list carries no delete answer); the rig answers from its fixtures.
    canDelete: vi.fn(async (files: unknown) => [files].flat().map((file) => (file as { canDelete?: boolean }).canDelete === true)),
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place?: { folder?: string }) => listedIn(ENTRIES, place)),
    onChanged: vi.fn(() => () => {}),
    openWith: vi.fn(async () => {}),
    download: vi.fn(async () => true),
    keep: vi.fn(async (_entry: unknown, _how: string) => {}),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const ids = () => [...$('file-list').querySelectorAll<HTMLElement>('li.file')].map((li) => li.dataset.id)
// A time section's heading is its name (a button that folds it, with its count after); the folders' and files' headings are text.
const sections = () => [...$('file-list').querySelectorAll('.list-section:not(.list-more)')].map((li) => li.querySelector('.section-toggle > span')?.textContent ?? li.textContent)
const toggle = (name: string) => [...$('file-list').querySelectorAll<HTMLButtonElement>('.section-toggle')].find((b) => b.querySelector('span')?.textContent === name)!
const more = () => $('file-list').querySelector<HTMLButtonElement>('.section-more')
const row = (id: string) => document.querySelector(`[data-id="${id}"]`) as HTMLElement
const kind = (name: string) => $('kinds').querySelector<HTMLButtonElement>(`[data-kind="${name}"]`)!
const radios = (...path: string[]) => menu.rows(...path).filter((r) => r.checked !== undefined)
const openMenu = (id: string) => row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
const pressEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
const banner = () => [$('banner'), $('list-banner')].filter((node) => !node.hidden).map((node) => node.textContent).join('')

beforeAll(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now)
  localStorage.clear()
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the list drawn', () => ids().length > 0)
})

afterAll(() => vi.restoreAllMocks())

beforeEach(async () => {
  pressEscape()
  await menu.dismiss()
  kind('all').click()
  if ($('sort-label').textContent !== '最近') {
    $('sort').click()
    await menu.pick('最近')
  }
})

describe('kinds and order', () => {
  test('newest change first, under today / yesterday / the past 7 days / each month', () => {
    expect(ids()).toEqual(['spec', 'clip', 'shot', 'pack', 'notes'])
    expect(sections()).toEqual(['今天', '昨天', '过去 7 天', '2026年9月'])
  })

  test('a kind shows only its files, and is kept on this device', () => {
    kind('docs').click()
    expect(ids()).toEqual(['spec', 'notes'])
    expect(kind('docs').getAttribute('aria-pressed')).toBe('true')
    kind('media').click()
    expect(ids()).toEqual(['clip', 'shot'])
    kind('other').click()
    expect(ids()).toEqual(['pack'])
    expect(localStorage.getItem('workspace.kind')).toBe('other')
  })

  test('by size or by name: one run, no time sections', async () => {
    $('sort').click()
    expect(radios().map((r) => [r.label, r.checked])).toEqual([['最近', true], ['名称', false], ['大小', false]])
    await menu.pick('大小')
    expect(ids()).toEqual(['pack', 'spec', 'clip', 'shot', 'notes'])
    expect(sections()).toEqual([])
    expect($('sort-label').textContent).toBe('大小')
    expect(localStorage.getItem('workspace.sort')).toBe('size')
    $('sort').click()
    await menu.pick('名称')
    expect(ids()).toEqual(['clip', 'notes', 'pack', 'shot', 'spec'])
  })
})

describe('a row: its suffix, its size, how long its cloud copy has left, the machine it stays on', () => {
  test('the line says who, when and how big; the mark is the host\'s tile by the file\'s name', () => {
    expect([...row('spec').querySelector('.file-meta')!.children].map((c) => c.textContent)).toEqual([expect.stringMatching(/\d\d:\d\d/), '1.1 MB'])
    expect(row('spec').querySelector('gugu-file-mark.file-mark[tile]')!.getAttribute('name')).toBe('spec.pdf')
    expect(row('pack').querySelector('gugu-file-mark.file-mark[tile]')!.getAttribute('name')).toBe('pack.zip')
  })

  test('a copy kept for a while says how long, faintly; under a day it says hours; the day it goes on hover', () => {
    expect(row('spec').querySelector('.file-keep'), 'more than three days: Details keeps the full retention').toBe(null)
    const clip = row('clip').querySelector<HTMLElement>('.file-keep')!
    expect(clip.textContent).toBe('临时保留 5 小时')
    expect(clip.hasAttribute('data-soon')).toBe(true)
    expect(row('pack').querySelector('.file-keep'), 'kept cloud copy: nothing to say (owner 10-28)').toBe(null)
  })

  test('a project file that stays on its machine names the machine; the rest on hover', () => {
    const host = row('shot').querySelector<HTMLElement>('.file-host')!
    expect(host.textContent).toBe('')
    expect(host.querySelector('gugu-icon')?.getAttribute('name')).toBe('server')
    expect(host.title).toContain('R server')
  })
})

// @@@file-menu: how long the cloud copy is kept is set in the details, not in the menu.
describe('「临时 / 持续保存」 in the details', () => {
  const openDetails = async (id: string) => {
    openMenu(id)
    await menu.pick('更多', '详情')
  }
  const keepButtons = () => [...document.querySelectorAll<HTMLButtonElement>('#details .details-keep button')]

  test('the menu has no keep rows: they are in the details', async () => {
    openMenu('spec')
    expect(menu.labels()).not.toContain('保留方式')
    expect(menu.labels('更多')).not.toContain('保留方式')
    await menu.dismiss()
  })

  test('my upload: both ways offered, the current one pressed; choosing one keeps it so and reads the list again', async () => {
    await openDetails('spec')
    expect(keepButtons().map((b) => [b.textContent, b.getAttribute('aria-pressed'), b.disabled])).toEqual([['临时', 'true', false], ['持续保存', 'false', false]])
    const reads = gugu.files.list.mock.calls.length
    keepButtons()[1]!.click()
    await until('the list read again', () => gugu.files.list.mock.calls.length > reads)
    expect(gugu.files.keep).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'spec' }), 'permanent')
  })

  test('someone else\'s upload: shown, not choosable, why said; no cloud copy: no switch', async () => {
    await openDetails('clip')
    expect(keepButtons().map((b) => b.disabled)).toEqual([true, true])
    expect(document.querySelector<HTMLElement>('#details .details-keep')!.title).toBe('只有上传这份文件的人能改它保留多久。')
    await openDetails('shot')
    expect(keepButtons(), 'a file that stays on its machine has no cloud copy to keep').toEqual([])
    expect(document.getElementById('details')!.textContent).toContain('没有云端副本')
    await openDetails('notes')
    expect(keepButtons(), 'a document has no cloud copy to keep').toEqual([])
  })

  test('a refusal is said on the list', async () => {
    gugu.files.keep.mockRejectedValueOnce(Object.assign(new Error('Only the person who uploaded a file can change how long it is kept'), { code: 'denied' }))
    await openDetails('pack')
    keepButtons()[0]!.click()
    await until('the refusal said', () => banner(), (said) => said === '只有上传这份文件的人能改它保留多久。')
  })
})

describe('a file that arrives while the folder is open', () => {
  // A change is read one file at a time, without `keep`: a new file is read again with the list, so its details say 「保留」.
  test('is read again with the list, once, and then says how long its cloud copy is kept', async () => {
    const [, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
    const arrived = file('late', 'late.pdf', 'application/pdf', 10, ago(5))
    const listed = { ...arrived, keep: { expiresAt: null, mine: false } }
    gugu.files.list.mockImplementation(async (place?: { folder?: string }) => listedIn([...ENTRIES, listed], place))
    const reads = gugu.files.list.mock.calls.length
    // The app reads the folder again a moment (800 ms) after the last change; that moment runs on a fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      changed({ kind: 'entries', entries: [arrived], gone: [] })
      changed({ kind: 'entries', entries: [{ ...arrived, name: 'late.pdf' }], gone: [] })
      expect(ids()).toContain('late')
      await vi.advanceTimersByTimeAsync(799)
      expect(gugu.files.list.mock.calls.length, 'not read before the moment').toBe(reads)
      await vi.advanceTimersByTimeAsync(1)
      expect(gugu.files.list.mock.calls.length, 'read again with the list').toBe(reads + 1)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(gugu.files.list.mock.calls.length, 'two changes, one read').toBe(reads + 1)
    } finally { vi.useRealTimers() }
    openMenu('late')
    await menu.pick('更多', '详情')
    expect([...document.querySelectorAll<HTMLButtonElement>('#details .details-keep button')].map((b) => b.disabled)).toEqual([true, true])
  })
})

// owner 11-06: a time section folds away from its heading, and a long one shows its first 20 with 「再显示 N 条」 under them.
describe('a long time section', () => {
  test('shows its first 20 under its heading and its count, the rest one press away; the heading folds it away and back', async () => {
    const [, changed] = gugu.files.onChanged.mock.calls.at(-1) as unknown as [unknown, (change: unknown) => void]
    const many = Array.from({ length: 25 }, (_, i) => file(`today-${i}`, `today-${String(i).padStart(2, '0')}.txt`, 'text/plain', 10, ago(60 + i)))
    gugu.files.list.mockImplementation(async (place?: { folder?: string }) => listedIn([...ENTRIES, ...many], place))
    changed({ kind: 'entries', entries: many, gone: [] })
    await until('the new files drawn', () => ids().includes('today-0'))
    const today = () => ids().filter((id) => id !== undefined && (id.startsWith('today-') || id === 'spec' || id === 'clip' || id === 'late'))
    const inToday = 25 + ENTRIES.filter((e) => Date.parse(e.updatedAt) > now - 12 * 3600_000).length + (ids().includes('late') ? 1 : 0)
    expect(toggle('今天').querySelector('.section-count')!.textContent).toBe(String(inToday))
    expect(today()).toHaveLength(20)
    expect(more()!.textContent).toBe(`再显示 ${inToday - 20} 条`)
    // The other sections are still there, after it.
    expect(sections()).toEqual(['今天', '昨天', '过去 7 天', '2026年9月'])
    more()!.click()
    expect(today()).toHaveLength(inToday)
    expect(more()).toBeNull()
    toggle('今天').click()
    expect(today()).toHaveLength(0)
    expect(toggle('今天').getAttribute('aria-expanded')).toBe('false')
    expect(ids()).toContain('shot')
    toggle('今天').click()
    expect(today()).toHaveLength(inToday)
    expect(toggle('今天').getAttribute('aria-expanded')).toBe('true')
  })
})
