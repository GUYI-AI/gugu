// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/markdown/Markdown'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { PaneContext, type PaneContextValue } from '@renderer/features/tabs/pane-context'
import { ChatPaneContent } from '@/components/appSlot/ChatTabHosts'
import { followLink } from '@/lib/guguLinks'

vi.mock('@renderer/features/chats/chat-tabs/chat-layouts', () => ({
  chatLayoutOf: () => ({ groups: [{ paneId: 'chat-pane', pane: { open, entries: new Map([['conversation', {}]]) } }], windowPanes: new Map(), activePaneId: 'chat-pane' }),
  chatTabOf: () => 'conversation',
}))
vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
vi.mock('@/lib/guguLinks', () => ({ followLink: vi.fn(() => false) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const web = 'https://example.org/prices'
const open = vi.fn()
const pane = { paneId: 'reading-pane', pane: { open }, isFocusedPane: true } as unknown as PaneContextValue
let host: HTMLDivElement, root: Root

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom omits CSS.escape; the anchor fixture below needs only this simple identifier.
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })

async function draw(content: string, file = true, inPane = true) {
  const body = file ? createElement(FileTextContent, { kind: 'markdown', content }) : createElement(Markdown, { trust: 'chat', content })
  await act(async () => root.render(createElement(PaneContext.Provider, { value: inPane ? pane : null }, body)))
}

/** Observe whether the product claimed the click before the browser's default navigation would run. */
async function click(href: string, modifiers: MouseEventInit = {}) {
  const anchor = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.getAttribute('href') === href)!
  expect(anchor).toBeDefined()
  let handled = false
  host.addEventListener('click', event => { handled = event.defaultPrevented; event.preventDefault() }, { once: true })
  await act(async () => anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers })))
  return handled
}

describe('Markdown web links in a file tab and a chat', () => {
  it.each([true, false])('opens an ordinary click in the pane (file=%s)', async file => {
    await draw(`[prices](${web})`, file)
    expect(await click(web)).toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith('browser', { initialUrl: web }, { intent: file ? 'newTab' : 'beside' })
  })

  it.each([true, false].flatMap(file => [{ file, metaKey: true }, { file, ctrlKey: true }]))('keeps modified clicks on the system-browser path: %j', async ({ file, ...modifiers }) => {
    await draw(`[prices](${web})`, file)
    expect(await click(web, modifiers)).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(host.querySelector('a')?.target).toBe('_blank')
  })

  it('passes the desktop conversation pane through the shell-owned chat content', async () => {
    await act(async () => root.render(createElement(ChatPaneContent, { chatId: 'chat-1', inPane: true },
      createElement(Markdown, { trust: 'chat', content: `[prices](${web})` }))))
    expect(await click(web)).toBe(true)
    expect(open).toHaveBeenCalledExactlyOnceWith('browser', { initialUrl: web }, { intent: 'beside' })
  })

  it('keeps the external fallback when no desktop pane is present', async () => {
    await draw(`[prices](${web})`, true, false)
    expect(await click(web)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['./other.md#section', '../notes.md', '/tmp/notes.md'])('keeps an unclaimed file path from becoming a web tab: %s', async href => {
    await draw(`[notes](${href})`)
    expect(await click(href)).toBe(true)
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps the dialect sanitizing file:// URLs', async () => {
    await draw('[notes](file:///tmp/notes.md)')
    expect(host.querySelector('a')?.getAttribute('href') ?? '').toBe('')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['mailto:reader@example.org', 'tel:+1234567'])('keeps the existing default application for %s', async href => {
    await draw(`[contact](${href})`)
    expect(await click(href)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps a Gugu file link with its existing opener, even with Cmd held', async () => {
    const href = 'gugu-file://bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb?v=2#section'
    vi.mocked(followLink).mockReturnValueOnce(true)
    await draw(`[notes](${href})`)
    expect(await click(href, { metaKey: true })).toBe(true)
    expect(followLink).toHaveBeenCalledWith(href)
    expect(open).not.toHaveBeenCalled()
  })

  it('keeps heading anchors inside the document, including modified clicks', async () => {
    const scroll = vi.fn()
    await draw('# Section\n\n[jump](#section)')
    const heading = host.querySelector('h1')!
    heading.scrollIntoView = scroll
    expect(await click('#section', { ctrlKey: true })).toBe(true)
    expect(scroll).toHaveBeenCalledOnce()
    expect(followLink).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})
