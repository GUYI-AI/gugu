// @vitest-environment jsdom
// The same Files App switches between chat and computer files without an intermediate roots page.
// 工作目录一次只读一层(`files.list({ workspace, folder })`,文件面板同一条链):进一个文件夹才读那一层,读过的不再读;
// 那几层的变化经 onChanged 推来。父提交上没有工作目录这个根:这里每一格都红。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const at = '2026-10-31T12:00:00Z'
type Entry = { id: string; name: string; displayName: string; type: string; contentType: string; parentId: string | null; path: string; workspace?: string; chat?: string; systemRole: null; version: number | null; createdBy: null; createdAt: string; updatedAt: string; sourceMessageIds: string[]; canDelete: boolean; size: number | null }
const WS = 'session:task-1'
const wc = (path: string, type: 'folder' | 'text'): Entry => {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  const name = path.split('/').pop()!
  return { id: path, name, displayName: name, type, contentType: type === 'folder' ? 'inode/directory' : 'text/markdown', parentId: parent, path, workspace: WS, systemRole: null, version: null, createdBy: null, createdAt: at, updatedAt: at, sourceMessageIds: [], canDelete: true, size: type === 'folder' ? null : 3 }
}
const TREE: Record<string, Entry[]> = {
  '': [wc('.git', 'folder'), wc('src', 'folder'), wc('README.md', 'text')],
  src: [wc('src/main.md', 'text'), wc('src/lib', 'folder')],
}
const chatNote: Entry = { ...wc('x', 'text'), id: 'item-1', name: 'plan.md', displayName: 'plan.md', path: 'plan.md', parentId: null, workspace: undefined, chat: 'dm-1' }
delete chatNote.workspace
let touch = false

const context = {
  chat: { id: 'dm-1', name: 'Kip', kind: 'dm', groupId: null, members: [] },
  workspace: { id: WS, sessionId: 'task-1', agentId: 'user:kip' },
  locale: 'zh-CN',
  capabilities: ['files:read', 'files:write'],
}
let hear: ((change: unknown) => void) | null = null
let contextChanged: ((ctx: unknown) => void) | null = null
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn((fn: (ctx: unknown) => void) => { contextChanged = fn; return () => {} }),
  onLink: vi.fn(() => () => {}),
  showContextMenu: vi.fn(async () => null),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place: { chat?: string; workspace?: string; folder?: string }) =>
      place.workspace ? (TREE[place.folder ?? ''] ?? []).map((e) => ({ ...e })) : [{ ...chatNote }]),
    onChanged: vi.fn((place: { workspace?: string }, fn: (change: unknown) => void) => {
      if (place.workspace) hear = fn
      return () => {}
    }),
    open: vi.fn(),
    openWith: vi.fn(async () => {}),
    canDelete: vi.fn(async () => [false]),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const names = () => [...$('file-list').querySelectorAll('.file .file-name')].map((n) => n.textContent)
const press = (name: string) => ([...$('file-list').querySelectorAll('.file')].find((li) => li.querySelector('.file-name')?.textContent === name)!.querySelector('.file-open') as HTMLButtonElement).click()
const crumbs = () => ($('crumbs').hidden ? null : [...$('crumbs').querySelectorAll('.crumb')].map((c) => c.textContent))
const crumb = (i: number) => ($('crumbs').querySelectorAll('.crumb')[i] as HTMLButtonElement).click()
const listed = () => gugu.files.list.mock.calls.map(([place]) => place)
const switchRoot = (root: string) => (document.querySelector(`#place-switch [data-root="${root}"]`) as HTMLButtonElement).click()
const workspaceListed = () => listed().filter((place) => place.workspace)

beforeAll(async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ get matches() { return query === '(hover: none) and (pointer: coarse)' && touch }, addEventListener() {} }))
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  const page = new DOMParser().parseFromString(html, 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (s: string) => s } })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the roots drawn', () => names().length > 0)
})
afterAll(() => vi.unstubAllGlobals())

describe('a session\'s tab: one folder, two roots', () => {
  test('the two buttons stay above the chat files, with no roots page to enter', () => {
    expect(names()).toEqual(['plan.md'])
    expect(listed()).toEqual([{ chat: 'dm-1', folder: '' }, { chat: 'dm-1', folder: '附件' }])
    expect([...$('place-switch').querySelectorAll('button')].map((button) => button.title)).toEqual(['聊天文件', '电脑文件'])
    expect($('place-switch').querySelector('[aria-pressed="true"]')?.getAttribute('data-root')).toBe('chat')
    expect(crumbs()).toBeNull()
  })

  test('the working copy lists its top, then a folder only when it is entered — once', async () => {
    switchRoot('workspace')
    await until('the top listed', () => names().includes('README.md'))
    expect(names(), 'hidden folders after the others').toEqual(['src', '.git', 'README.md'])
    expect(crumbs(), 'a computer\'s folder always says which one it is').toEqual(['电脑文件'])
    expect(($('crumbs').querySelector('.back') as HTMLButtonElement).disabled, 'nowhere up from the top').toBe(true)
    press('src')
    await until('src listed', () => names().includes('main.md'))
    expect(names()).toEqual(['lib', 'main.md'])
    expect(crumbs()).toEqual(['电脑文件', 'src'])
    expect(workspaceListed()).toEqual([{ workspace: WS, folder: '' }, { workspace: WS, folder: 'src' }])
    crumb(0)
    expect(names()).toEqual(['src', '.git', 'README.md'])
    press('src')
    expect(workspaceListed()).toHaveLength(2)
  })

  test('a change in a folder listed reads that folder again; one in a folder never listed reads nothing', async () => {
    TREE.src = [...TREE.src!, wc('src/new.md', 'text')]
    hear!({ kind: 'changes', changes: [{ kind: 'create', path: 'src/new.md' }] })
    await until('src read again', () => names().includes('new.md'))
    const calls = listed().length
    hear!({ kind: 'changes', changes: [{ kind: 'update', path: 'src/lib/deep.md' }] })
    expect(listed()).toHaveLength(calls)
    TREE.src = TREE.src!.filter((e) => e.id !== 'src/new.md')
    hear!({ kind: 'changes', changes: [{ kind: 'delete', path: 'src/new.md' }] })
    await until('src read again', () => !names().includes('new.md'))
  })

  test('the conversation\'s folder is the other root: listed by its chat, one folder at a time, as in a group', async () => {
    const calls = listed().length
    switchRoot('chat')
    await until('the chat listed', () => names().includes('plan.md'))
    expect(listed().slice(calls)).toEqual([{ chat: 'dm-1', folder: '' }, { chat: 'dm-1', folder: '附件' }])
    expect(crumbs()).toBeNull()
  })

  test('its conversation arriving later keeps the person where they are in the working copy (no jump to the top)', async () => {
    switchRoot('workspace')
    await until('the top drawn', () => names().includes('src'))
    press('src')
    await until('src drawn', () => names().includes('main.md'))
    const calls = listed().length
    // The same working copy; the conversation changes (it was not there yet, then is): nothing to read again.
    contextChanged!({ ...context, chat: { ...context.chat, id: 'dm-2' } })
    await until('the context applied', () => gugu.files.onChanged.mock.calls.some(([place]) => (place as { chat?: string }).chat === 'dm-2'))
    expect([crumbs(), names().includes('main.md'), listed().length]).toEqual([['电脑文件', 'src'], true, calls])
  })

  test('a working copy\'s file has no link: none is asked for, and its menu goes by the path', async () => {
    expect(gugu.linkTo.mock.calls.filter((args: unknown[]) => (args[0] as { file?: Entry } | undefined)?.file?.workspace)).toEqual([])
    const row = [...document.querySelectorAll('li')].find((li) => li.textContent?.includes('main.md'))!
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const items = () => [...document.getElementById('menu')!.querySelectorAll('button')].map((item) => item.textContent)
    await until('the menu open', () => items().length > 0)
    expect(items()).not.toContain('复制链接')
    expect(items()).toContain('复制相对路径')
  })

  test('computer-file selection offers no chat retention or source-location actions', () => {
    (document.querySelector('[data-id="src/main.md"] .file-pick') as HTMLButtonElement).click()
    const labels = [...$('pick-bar').querySelectorAll('button')].map((button) => button.textContent)
    expect(labels).toContain('下载')
    expect(labels).not.toContain('设为临时')
    expect(labels).not.toContain('设为持续保存')
    expect(labels).not.toContain('在聊天中定位')
  })

  test('each chat remembers its own root, with unavailable roots falling back to chat files', async () => {
    switchRoot('chat')
    await until('chat shown', () => names().includes('plan.md'))
    switchRoot('workspace')
    await until('computer shown', () => names().includes('README.md'))
    const other = { ...context, chat: { ...context.chat, id: 'other' }, workspace: { ...context.workspace, id: 'session:other' } }
    contextChanged!(other)
    await until('other chat defaults to chat files', () => names().includes('plan.md'))
    contextChanged!({ ...context, chat: { ...context.chat, id: 'dm-2' } })
    await until('previous choice restored', () => names().includes('README.md'))
    contextChanged!({ ...context, workspace: undefined })
    await until('missing computer falls back to chat files', () => names().includes('plan.md'))
    expect($('place-switch').hidden, 'one place: no switch to press').toBe(true)
    contextChanged!({ ...context, chat: { ...context.chat, id: 'dm-2' } })
    await until('the computer back, the switch back', () => !$('place-switch').hidden)
    expect(names()).toEqual(['src', '.git', 'README.md'])
    contextChanged!({ ...context, workspace: undefined })
    await until('the computer gone, the switch gone', () => $('place-switch').hidden === true)
  })

  test('the path says where a computer\'s folder is: its whole path, or the machine when that is another one', async () => {
    contextChanged!({ ...context, chat: { ...context.chat, id: 'paths' }, workspace: { ...context.workspace, root: '/Users/me/proj' } })
    switchRoot('workspace')
    await until('its top', () => names().includes('README.md'))
    expect(crumbs()).toEqual(['/Users/me/proj'])
    press('src')
    await until('src', () => names().includes('main.md'))
    expect(crumbs()).toEqual(['/Users/me/proj', 'src'])
    crumb(0)
    expect(names()).toEqual(['src', '.git', 'README.md'])
    contextChanged!({ ...context, chat: { ...context.chat, id: 'paths' }, workspace: { ...context.workspace, deviceLabel: 'Studio' } })
    await until('the machine', () => crumbs()?.[0] === 'Studio · 电脑文件')
    switchRoot('chat')
  })

  test('the folder tasks without a project share says what it is', async () => {
    const top = TREE['']!
    TREE[''] = []
    try {
      contextChanged!({ ...context, chat: { ...context.chat, id: 'home' }, workspace: { id: 'session:home', sessionId: 'home', taskHome: true, root: '/data/task-home' } })
      switchRoot('workspace')
      await until('its top read', () => crumbs()?.[0] === '/data/task-home' && !$('files-empty').hidden)
      expect($('files-empty-detail').textContent).toContain('没选项目的任务都在这个文件夹工作')
    } finally {
      TREE[''] = top
    }
    switchRoot('chat')
    contextChanged!(context)
    await until('back', () => names().includes('plan.md') || names().includes('README.md'))
  })

  describe('a project group: its folders are its computer files', () => {
    const group = { id: 'proj', name: 'P', kind: 'group', groupId: 'proj', members: [] }
    const here = { workspace: 'folder:dev-a/w1', path: '/home/me/app', machine: 'Laptop', online: true, thisMachine: true }
    const away = { workspace: 'folder:dev-b/w2', path: '/srv/data', machine: 'Server', online: false, thisMachine: false }
    const rows = () => [...$('file-list').querySelectorAll('.file')].map((row) => row.querySelector('.file-meta')?.textContent)

    test('one folder: no extra level', async () => {
      contextChanged!({ ...context, workspace: undefined, chat: { ...group, folders: [here] } })
      await until('the switch drawn', () => !$('place-switch').hidden)
      switchRoot('workspace')
      await until('its top', () => names().includes('README.md'))
      expect(listed().at(-1)).toEqual({ workspace: here.workspace, folder: '' })
      expect(crumbs()).toEqual(['/home/me/app'])
    })

    test('several: pick one, read it, and come back to pick another; another machine is read-only and says when it is out', async () => {
      contextChanged!({ ...context, workspace: undefined, chat: { ...group, id: 'proj2', folders: [here, away] } })
      await until('the switch drawn', () => !$('place-switch').hidden)
      switchRoot('workspace')
      await until('the choice', () => rows().length === 2)
      expect(rows()).toEqual(['/home/me/app', 'Server · 离线 · /srv/data'])
      expect(crumbs()).toEqual(['电脑文件'])
      press('app')
      await until('its top', () => names().includes('README.md'))
      expect(crumbs()).toEqual(['电脑文件', '/home/me/app'])
      gugu.files.openWith.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('elsewhere'), { code: 'elsewhere' })))
      press('README.md')
      await until('it says where to open it', () => $('list-banner').textContent === '请在 Laptop 上打开这个文件。')
      ;($('crumbs').querySelector('.back') as HTMLButtonElement).click()
      await until('back to the choice', () => rows().length === 2)
      expect($('list-banner').hidden, 'and the word goes with the folder').toBe(true)
      gugu.files.list.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('offline'), { code: 'unavailable' })))
      press('data')
      await until('it says so', () => $('files-empty-message').textContent === 'Server 现在离线，上线后才能看这个文件夹。')
      expect(($('upload') as HTMLButtonElement).hidden).toBe(true)
      expect(crumbs()).toEqual(['电脑文件', 'Server · /srv/data'])
      ;($('crumbs').querySelector('.back') as HTMLButtonElement).click()
      await until('back again', () => rows().length === 2)
      contextChanged!(context)
      switchRoot('chat')
      await until('back to the chat', () => names().includes('plan.md'))
    })

    test('a folder no longer on its machine says so', async () => {
      gugu.files.list.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('gone'), { code: 'not-found' })))
      contextChanged!({ ...context, workspace: undefined, chat: { ...group, id: 'proj3', folders: [here] } })
      await until('the switch drawn', () => !$('place-switch').hidden)
      const calls = listed().length
      gugu.files.list.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('gone'), { code: 'not-found' })))
      switchRoot('workspace')
      await until('it says so', () => listed().length > calls && $('files-empty-message').textContent === '这个文件夹在 Laptop 上找不到了。')
      contextChanged!(context)
      switchRoot('chat')
      await until('back', () => names().includes('plan.md'))
    })
  })

  test('a read of the other root still on its way has no say in the list now shown', async () => {
    contextChanged!({ ...context, chat: { ...context.chat, id: 'late' } })
    switchRoot('chat')
    await until('settled on the chat', () => names().includes('plan.md'))
    let fail: (e: Error) => void = () => {}
    gugu.files.list.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    contextChanged!({ ...context, chat: { ...context.chat, id: 'late-2' } })
    await until('its read asked', () => gugu.files.list.mock.calls.some(([place]) => place.chat === 'late-2'))
    switchRoot('workspace')
    await until('the computer listed', () => names().includes('README.md'))
    fail(new Error('fetch failed'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(names()).toContain('README.md')
    expect($('files-empty').hidden).toBe(true)
    switchRoot('chat')
    await until('the chat again', () => names().includes('plan.md'))
  })

  test('and the other way: the computer\'s late failure says nothing on the chat\'s list', async () => {
    const place = 'session:late-3'
    const real = gugu.files.list.getMockImplementation()!
    let fail: (e: Error) => void = () => {}
    // An empty chat: what the list says of itself is on screen, so a word from the other root would show.
    gugu.files.list.mockImplementation((asked: { chat?: string; workspace?: string; folder?: string }) =>
      asked.workspace === place ? new Promise((_, reject) => { fail = reject })
        : asked.chat === 'late-3' ? Promise.resolve([]) : real(asked))
    try {
      contextChanged!({ ...context, chat: { ...context.chat, id: 'late-3' }, workspace: { ...context.workspace, id: place } })
      await until('the chat read', () => !$('files-empty').hidden && $('files-empty-progress').hidden === true)
      switchRoot('workspace')
      await until('its read asked', () => gugu.files.list.mock.calls.some(([asked]) => asked.workspace === place))
      switchRoot('chat')
      await until('back on the chat', () => $('files-empty-progress').hidden === true)
      const said = $('files-empty-message').textContent
      fail(new Error('fetch failed'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect($('files-empty-message').textContent).toBe(said)
    } finally {
      gugu.files.list.mockImplementation(real)
    }
    contextChanged!(context)
    switchRoot('chat')
    await until('settled on the chat', () => names().includes('plan.md'))
  })

  test('phone computer files stay read-only, with no desktop navigation or draggable rows', async () => {
    touch = true
    contextChanged!({ ...context, chat: { ...context.chat, id: 'phone' } })
    await until('phone chat files shown', () => names().includes('plan.md'))
    switchRoot('workspace')
    await until('phone computer files shown', () => names().includes('README.md'))
    expect(($('upload') as HTMLButtonElement).hidden).toBe(true)
    expect(($('new-doc') as HTMLButtonElement).hidden).toBe(true)
    const row = document.querySelector('[data-id="README.md"]') as HTMLElement
    expect(row.draggable).toBe(false)
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const labels = [...$('menu').querySelectorAll('button')].map((button) => button.textContent)
    for (const desktop of ['在新页签打开', '在旁边打开', '在文件管理器中显示', '改名', '删除']) expect(labels).not.toContain(desktop)
    switchRoot('chat')
    await until('phone chat files shown again', () => names().includes('plan.md'))
    expect(($('upload') as HTMLButtonElement).hidden).toBe(false)
    expect((document.querySelector('[data-id="item-1"]') as HTMLElement).draggable).toBe(false)
  })
})
