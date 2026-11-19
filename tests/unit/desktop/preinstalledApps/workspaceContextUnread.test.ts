// @vitest-environment jsdom
// The group's files page with no network: the host cannot read the page's chat, so `getContext` fails. The list's place says
// so with 「重试」 (❌ the failure written into the hidden document pane: a blank page, for good); 重试 — or the network back —
// reads the context again and the list is drawn in place.
// The real app.js on a fake runtime: the first context read fails as the host's does offline.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const ctx = { chat: { id: 'chat-1', name: 'chat-1', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
const entry = { id: 'f1', name: 'notes.md', displayName: 'notes.md', contentType: 'text/markdown', type: 'text', size: 3, parentId: null, path: 'notes.md', systemRole: null, version: 1, createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z', createdBy: { id: 'u1', name: 'A', kind: 'human' }, sourceMessageIds: [] }
let online = false
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => {
    if (!online) throw new TypeError('fetch failed')
    return ctx
  }),
  onContextChanged: vi.fn(() => () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place: { folder?: string }) => (place.folder === '附件' ? [] : [entry])),
    onChanged: vi.fn(() => () => {}),
  },
}
const $ = (id: string) => document.getElementById(id) as HTMLElement
const shown = (node: HTMLElement) => !node.hidden && !node.closest('[hidden]') && getComputedStyle(node).display !== 'none'
const said = () => (shown($('files-empty')) ? $('files-empty-message').textContent : '')
const retry = () => $('files-retry') as HTMLButtonElement | null
const rows = () => document.querySelectorAll('#file-list li.file').length

beforeAll(async () => {
  const page = new DOMParser().parseFromString(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = page.body.innerHTML
  // The page's own rule: the document pane is not drawn while the list is (what hid the failure).
  const style = document.createElement('style')
  style.textContent = 'body:not(.show-doc):not(.no-list) .doc { display: none; }'
  document.head.append(style)
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — the preinstalled App is a plain ES module with no types.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
})

test('offline, the chat unread: the list says why with 重试; the network back draws the list in place', async () => {
  await until('the context asked', () => gugu.getContext.mock.calls.length === 1)
  await until('the failure said where the list would be', () => said().includes('fetch failed'))
  expect(retry() && shown(retry()!), '重试 offered').toBe(true)
  expect(retry()!.textContent).toBe('重试')
  // Still offline: tried again, said again (never a blank page).
  retry()!.click()
  await until('asked again', () => gugu.getContext.mock.calls.length === 2)
  await until('said again', () => said().includes('fetch failed') && shown(retry()!))
  // The network back: read again by itself, no press.
  online = true
  window.dispatchEvent(new Event('online'))
  await until('the list drawn', () => rows() === 1)
  expect(said()).toBe('')
  expect(shown(retry()!)).toBe(false)
  expect(gugu.getContext).toHaveBeenCalledTimes(3)
})
