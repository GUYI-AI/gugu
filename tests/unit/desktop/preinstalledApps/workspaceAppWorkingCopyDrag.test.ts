// @vitest-environment jsdom
// A working copy's rows dragged in the Folder App: what a row carries out (a chat reads the file's bytes where it is, a
// task gets a path pill — never the path as text), and a move that fails keeps its row where it was.
// On the parent commit the payload has no project and no folder mark, and a failed move took the row off the list.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const at = '2026-10-31T12:00:00Z'
const WS = 'session:task-1'
const wc = (path: string, type: 'folder' | 'text') => {
  const name = path.split('/').pop()!
  return {
    id: path, name, displayName: name, type, contentType: type === 'folder' ? 'inode/directory' : 'text/markdown',
    parentId: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null, path, workspace: WS, systemRole: null,
    version: null, createdBy: null, createdAt: at, updatedAt: at, sourceMessageIds: [], canDelete: true, size: type === 'folder' ? null : 3,
    absolutePath: `/home/me/repo/${path}`, projectId: 'project-1', workspaceId: 'workspace-1',
  }
}
const TREE = [wc('src', 'folder'), wc('notes.md', 'text')]

const context = {
  chat: { id: 'dm-1', name: 'Kip', kind: 'dm', groupId: null, members: [] },
  workspace: { id: WS, sessionId: 'task-1', agentId: 'user:kip' },
  locale: 'zh-CN',
  capabilities: ['files:read', 'files:write'],
}
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  showContextMenu: vi.fn(async () => null),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place: { workspace?: string; folder?: string }) => place.workspace && !place.folder ? TREE.map((e) => ({ ...e })) : []),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(),
    openWith: vi.fn(async () => {}),
    canDelete: vi.fn(async () => [false]),
    move: vi.fn(async () => { throw Object.assign(new Error('"Linux 1" is offline or paused'), { code: 'unavailable' }) }),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const names = () => [...$('file-list').querySelectorAll('.file .file-name')].map((n) => n.textContent)
const rowOf = (name: string) => [...$('file-list').querySelectorAll<HTMLElement>('.file')].find((li) => li.querySelector('.file-name')?.textContent === name)!
const dragEvent = (type: string, values: Map<string, string>) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: [...values.keys()], setData: (t: string, v: string) => values.set(t, v), getData: (t: string) => values.get(t) ?? '' } })
  return event
}

beforeAll(async () => {
  const html = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8')
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML
  Object.assign(globalThis, { gugu, CSS: { escape: (s: string) => s } })
  Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await until('the place switch drawn', () => !!document.querySelector('#place-switch [data-root="workspace"]'))
  ;(document.querySelector('#place-switch [data-root="workspace"]') as HTMLButtonElement).click()
  await until('the working copy listed', () => names().includes('notes.md'))
})

describe('a working copy row dragged', () => {
  test('carries its project, workspace and path; a folder says it is one', () => {
    const file = new Map<string, string>()
    rowOf('notes.md').dispatchEvent(dragEvent('dragstart', file))
    rowOf('notes.md').dispatchEvent(dragEvent('dragend', file))
    expect(JSON.parse(file.get('application/x-emdash-workspace-file')!)).toEqual({ projectId: 'project-1', workspaceId: 'workspace-1', targetPath: '/home/me/repo/notes.md' })
    const folder = new Map<string, string>()
    rowOf('src').dispatchEvent(dragEvent('dragstart', folder))
    rowOf('src').dispatchEvent(dragEvent('dragend', folder))
    expect(JSON.parse(folder.get('application/x-emdash-workspace-file')!)).toEqual({ projectId: 'project-1', workspaceId: 'workspace-1', targetPath: '/home/me/repo/src', directory: true })
  })

  test('a move that fails keeps the row, and says why', async () => {
    const values = new Map<string, string>()
    rowOf('notes.md').dispatchEvent(dragEvent('dragstart', values))
    rowOf('src').dispatchEvent(dragEvent('drop', values))
    await until('the move tried', () => gugu.files.move.mock.calls.length > 0)
    await until('the failure said', () => !$('list-banner').hidden)
    expect(names()).toEqual(['src', 'notes.md'])
    expect($('list-banner').dataset.tone).toBe('error')
  })
})
