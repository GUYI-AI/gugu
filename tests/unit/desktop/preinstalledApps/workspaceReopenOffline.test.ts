// @vitest-environment jsdom
// An empty group's files page, read online (「这里还没有文件」); the network drops; the page is closed and opened again in
// another tab. The host keeps the page and only tells it the new tab, so the list is read again: that read fails, and the
// failure is said over what was shown — kept, marked as not read now — with 重试 (❌ the old list shown as if read now,
// nothing said, nothing read again ever). 重试 or the network back reads it again in place.
// The real app.js on a fake runtime.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const ctx = { tabId: 'tab-1', chat: { id: 'chat-1', name: 'chat-1', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
let online = true
let contextChanged: (next: typeof ctx) => void = () => {}
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ctx),
  onContextChanged: vi.fn((fn: typeof contextChanged) => {
    contextChanged = fn
    return () => {}
  }),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async (place: { folder?: string }) => {
      if (!online) throw new TypeError('fetch failed')
      return place.folder === '附件' ? [] : []
    }),
    onChanged: vi.fn(() => () => {}),
  },
}
const $ = (id: string) => document.getElementById(id) as HTMLElement
const tops = () => gugu.files.list.mock.calls.filter(([place]) => (place as { folder?: string }).folder === '').length
const banner = () => ($('list-banner').hidden ? '' : $('list-banner').textContent ?? '')
const retry = () => $('list-banner').querySelector('button')
const empty = () => ($('files-empty').hidden ? '' : $('files-empty-message').textContent)

beforeAll(async () => {
  const page = new DOMParser().parseFromString(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — the preinstalled App is a plain ES module with no types.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
})

test('read empty online; offline, closed and opened again: the failed read is said over the kept list, with 重试', async () => {
  await until('read online: the group has no files', () => tops() === 1 && empty() === '这里还没有文件。')
  const shownOnline = empty()
  // Offline, the page left open: nothing is read, what it shows stays and nothing is said.
  online = false
  expect(banner()).toBe('')
  // Closed and opened again: the host tells the kept page its new tab.
  contextChanged({ ...ctx, tabId: 'tab-2' })
  await until('read again for the reopened tab', () => tops() === 2)
  await until('the failure said over the list', () => banner().includes('fetch failed'))
  expect(retry()?.textContent).toBe('重试')
  expect(empty(), 'what was shown stays').toBe(shownOnline)
  // Still offline: 重试 reads again and says it again.
  retry()!.click()
  await until('read again on 重试', () => tops() === 3)
  await until('said again', () => banner().includes('fetch failed'))
  // The network back: read again by itself, the failure gone.
  online = true
  window.dispatchEvent(new Event('online'))
  await until('read again when back online', () => tops() === 4)
  await until('nothing said any more', () => banner() === '')
  expect(empty()).toBe(shownOnline)
})
