// @vitest-environment jsdom
// A chat subfolder read before, opened again while its read fails: what was read stays and the failure is said over it in
// the list banner with 重试 (❌ the old rows shown as if read now, nothing said). The real app.js on a fake runtime.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const ctx = { tabId: 'tab-1', chat: { id: 'chat-1', name: 'chat-1', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
let online = true
const docs = { id: 'f-docs', name: 'Docs', type: 'folder', parentId: null, chatId: 'chat-1', updatedAt: '2026-11-17T00:00:00Z', size: 0 }
const note = { id: 'f-note', name: 'notes.md', type: 'file', parentId: 'f-docs', chatId: 'chat-1', updatedAt: '2026-11-17T00:00:00Z', size: 12, mimeType: 'text/markdown' }
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ctx),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place: { folder?: string }) => {
      if (!online) throw new TypeError('fetch failed')
      return place.folder === '' ? [docs] : place.folder === 'f-docs' ? [note] : []
    }),
    onChanged: vi.fn(() => () => {}),
  },
}
const $ = (id: string) => document.getElementById(id) as HTMLElement
const reads = (folder: string) => gugu.files.list.mock.calls.filter(([place]) => (place as { folder?: string }).folder === folder).length
const banner = () => ($('list-banner').hidden ? '' : $('list-banner').textContent ?? '')
const row = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)
const openRow = (id: string) => (row(id)?.querySelector('button, [role="button"], a') as HTMLElement | null ?? row(id))!.click()

beforeAll(async () => {
  const page = new DOMParser().parseFromString(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — the preinstalled App is a plain ES module with no types.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
})

test('a subfolder read before, opened again offline: its rows stay and the failed read is said with 重试', async () => {
  await until('the top read: Docs listed', () => row('f-docs') !== null)
  openRow('f-docs')
  await until('Docs read: notes.md listed', () => reads('f-docs') === 1 && row('f-note') !== null)
  // Back to the top, offline, Docs opened again: read again, which fails.
  ;(document.querySelector<HTMLElement>('#crumbs button, #crumbs a') ?? { click() {} }).click()
  await until('back at the top', () => row('f-docs') !== null && row('f-note') === null)
  online = false
  openRow('f-docs')
  await until('Docs read again', () => reads('f-docs') === 2)
  await until('the failure said over the rows', () => banner().includes('fetch failed'))
  expect($('list-banner').querySelector('button')?.textContent).toBe('重试')
  expect(row('f-note'), 'what was read stays').not.toBeNull()
  online = true
  window.dispatchEvent(new Event('online'))
  await until('read again when back online', () => reads('f-docs') === 3)
  await until('nothing said any more', () => banner() === '')
})
