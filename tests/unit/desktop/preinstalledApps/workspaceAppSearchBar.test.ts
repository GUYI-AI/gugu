// @vitest-environment jsdom
// 按名称筛选 (owner 11-07:「一按，头里面的按钮就都跳到左边」): the field opens in the kinds' place, before 🔍, and nothing else
// in the bar comes or goes — so 🔍 and what follows it keep their place; Esc, 取消, 🔍 again or leaving it empty puts the bar
// back as it was. Where things land in pixels is read in a real browser (gpu, 480 / 760 / phone 390); here the DOM and
// app.js's part of it.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, test, vi } from 'vitest'

const entries = [
  { id: 'plan', name: 'plan.md', displayName: 'plan.md', contentType: 'text/markdown', type: 'text', size: 10, updatedAt: new Date().toISOString() },
  { id: 'photo', name: 'photo.png', displayName: 'photo.png', contentType: 'image/png', type: 'binary', size: 100, updatedAt: new Date().toISOString() },
]
const context = { tabId: 'search-bar', chat: { id: 'chat-1', name: 'G', kind: 'group', groupId: 'chat-1' }, locale: 'zh-CN', capabilities: ['files:read', 'files:write'] }
let changed: (ctx: Record<string, unknown>) => Promise<void>
const gugu = {
  linkTo: vi.fn(async ({ file }: { file: { id: string } }) => `gugu-file://${file.id}`),
  getContext: vi.fn(async () => context),
  onContextChanged: vi.fn((fn: typeof changed) => { changed = fn; return () => {} }),
  onLink: vi.fn(() => () => {}),
  setTabTitle: vi.fn(async () => {}),
  files: {
    viewPreferences: vi.fn(async () => ({ showAppData: false })),
    list: vi.fn(async () => entries),
    onChanged: vi.fn(() => () => {}),
    open: vi.fn(async () => { throw new Error('rig: no file service here') }),
    canDelete: vi.fn(async () => [true]),
  },
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const filter = () => $('filter') as HTMLInputElement
const listed = () => [...document.querySelectorAll('.file-name')].map((name) => name.textContent)
// The bar's own controls, in order, and which of them are hidden.
const bar = () => [...document.querySelector('.files-toolbar')!.children].map((child) => `${child.id}${(child as HTMLElement).hidden ? ':hidden' : ''}`)
const type = (text: string) => { filter().value = text; filter().dispatchEvent(new Event('input')) }

beforeAll(async () => {
  const page = new DOMParser().parseFromString(readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/index.html'), 'utf8'), 'text/html')
  document.body.innerHTML = page.body.innerHTML
  for (const attr of Array.from(page.body.attributes)) document.body.setAttribute(attr.name, attr.value)
  Object.assign(globalThis, { gugu }); Object.assign(window, { gugu })
  // @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
  await import('../../../../apps/desktop/preinstalled-apps/workspace/app.js')
  await vi.waitFor(() => expect(listed()).toHaveLength(2))
})

describe('workspace App: 按名称筛选 keeps the bar still', () => {
  test('the field sits before 🔍 and opening it shows only the field: nothing after 🔍 moves', () => {
    const closed = bar()
    const order = closed.map((id) => id.replace(':hidden', ''))
    expect(order.indexOf('search'), 'the field is in the kinds\' place, not between 🔍 and the order').toBe(order.indexOf('search-toggle') - 1)
    expect(closed).toContain('search:hidden')
    $('search-toggle').click()
    expect(bar(), 'only the field comes; the kinds go by CSS (the phone keeps them, covered)').toEqual(closed.map((id) => (id === 'search:hidden' ? 'search' : id)))
    expect($('search-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(filter())
    // Control (dev 8b5021a92): style.css hid the kinds and capped the field at 180 px, so the row lost the kinds'
    // margin-right: auto and packed left. Now 🔍 itself holds the row to the right whatever is drawn on its left, the field's
    // box fills that room, and the field inside stops at 360 against 🔍.
    const css = readFileSync(resolve(process.cwd(), 'apps/desktop/preinstalled-apps/workspace/style.css'), 'utf8')
    expect(css).toMatch(/\.files-toolbar > \.search \{ flex: 1;[^}]*justify-content: flex-end;/)
    expect(css).toMatch(/\.files-toolbar > #search-toggle \{ margin-inline-start: auto; \}/)
    expect(css).not.toMatch(/\.filter[^{]*\{[^}]*max-width: 180px/)
  })

  test('Esc empties the field, closes it and hands the focus back to 🔍', () => {
    type('plan')
    expect(listed()).toEqual(['plan.md'])
    expect($('filter-clear').hidden).toBe(false)
    filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(filter().value).toBe('')
    expect($('search').hidden).toBe(true)
    expect($('search-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe($('search-toggle'))
    expect(listed()).toHaveLength(2)
  })

  test('× empties it and keeps it open; left empty, it closes', () => {
    $('search-toggle').click()
    type('photo')
    $('filter-clear').click()
    expect(filter().value).toBe('')
    expect($('filter-clear').hidden).toBe(true)
    expect($('search').hidden).toBe(false)
    expect(listed()).toHaveLength(2)
    filter().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    expect($('search').hidden).toBe(true)
  })

  test('a word in it keeps it open past a blur; 🔍 again and 取消 each empty and close it', () => {
    $('search-toggle').click()
    type('plan')
    filter().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }))
    expect($('search').hidden).toBe(false)
    $('search-toggle').click()
    expect([filter().value, $('search').hidden]).toEqual(['', true])
    $('search-toggle').click()
    type('plan')
    expect($('search-cancel').textContent).toBe('取消')
    $('search-cancel').click()
    expect([filter().value, $('search').hidden, listed().length]).toEqual(['', true, 2])
  })

  test('a list restored with a word in it shows the field with that word', async () => {
    await changed({ ...context, viewState: { root: 'chat', folder: null, filter: 'photo', kind: 'all', sort: 'recent' } })
    expect(filter().value).toBe('photo')
    expect($('search').hidden).toBe(false)
    expect($('search-toggle').getAttribute('aria-expanded')).toBe('true')
  })
})
