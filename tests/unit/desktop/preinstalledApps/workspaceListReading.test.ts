// @vitest-environment jsdom
// A folder whose list is still on its way is not an empty folder: the empty state ("No files here yet.", Upload) is drawn
// only once the read came back with nothing; until then the list says it is reading.
// The real app.js on a fake runtime: each list of the top is held until the test answers it.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, expect, test, vi } from 'vitest'
import { until } from '../../../support/awaitCondition'

const ctx = { chat: { id: 'chat-1', name: 'chat-1', kind: 'group', groupId: 'chat-1' }, locale: 'en-US', capabilities: ['files:read', 'files:write'] }
const held: ((entries: unknown[]) => void)[] = []
let contextChanged: (next: typeof ctx) => void = () => {}
const gugu = {
  linkTo: vi.fn(async () => 'gugu-file://x'),
  setTabTitle: vi.fn(async () => {}),
  getContext: vi.fn(async () => ctx),
  onContextChanged: vi.fn((fn: typeof contextChanged) => {
    contextChanged = fn
    return () => {}
  }),
  openBrowserTab: vi.fn(async () => {}),
  onLink: vi.fn(() => () => {}),
  showMessage: vi.fn(async () => {}),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn((place: { folder?: string }) => place.folder === '附件' ? Promise.resolve([]) : new Promise((done) => held.push(done))),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async () => { throw new Error('rig: no file service here') }),
  },
}
const $ = (id: string) => document.getElementById(id) as HTMLElement

beforeAll(async () => {
  const page = new DOMParser().parseFromString(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = page.body.innerHTML
  Object.assign(globalThis, { gugu })
  Object.assign(window, { gugu })
  // @ts-expect-error — the preinstalled App is a plain ES module with no types.
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
})

test('reading, then empty: "No files here yet." only once the folder was read', async () => {
  await until('the top is asked for', () => held.length === 1)
  expect($('files-empty-message').textContent, 'parent: "No files here yet." while the list was still out').toBe('Loading…')
  expect($('files-empty-progress').hidden).toBe(false)
  expect($('empty-upload').hidden).toBe(true)
  held[0]!([])
  await until('the empty answer drawn', () => $('files-empty-message').textContent === 'No files here yet.')
  expect($('files-empty-progress').hidden).toBe(true)
  expect($('empty-upload').hidden).toBe(false)
})

test('a folder this App may not read says so, not that it is being read', async () => {
  contextChanged({ ...ctx, chat: { ...ctx.chat, id: 'chat-2', name: 'chat-2', groupId: 'chat-2' }, capabilities: [] })
  await until('the refusal drawn', () => $('files-empty-message').textContent === 'This App may not read this folder.')
  expect($('files-empty-progress').hidden).toBe(true)
  expect($('empty-upload').hidden).toBe(true)
  expect(held).toHaveLength(1)
})
