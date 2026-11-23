// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentContextMenuHost } from '@/components/ContentContextMenuHost'
import { CONTENT_CONTEXT_MENU_ACTION, CONTENT_CONTEXT_MENU_OPEN, type ContentContextMenu } from '@/session/shared/content-context-menu'
import { HOST_LAYER_SHOW } from '@/session/shared/aux-window'
import { clickElement, createNode, createReactHarness } from '../../../support/testHarness'

const bridge = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), eventOn: vi.fn() }))
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => bridge }))
let receive: (menu: ContentContextMenu) => void
let harness: ReturnType<typeof createReactHarness>
// The layer main puts above native views is a same-origin document opened by window.open (electron/host-layer.ts).
const frame = document.createElement('iframe')
document.documentElement.append(frame)
const layer = frame.contentWindow!
vi.spyOn(window, 'open').mockImplementation(() => layer)
const items = () => [...layer.document.body.querySelectorAll<HTMLElement>('[role=menuitem]')]
const model: ContentContextMenu = { requestId: 'captured', x: 20, y: 30, items: [
  { id: 'copy', label: 'Copy', hotkey: 'Mod+C', enabled: false },
  { type: 'separator' },
  { id: 'quote', label: 'Quote file', icon: 'file' },
] }

beforeEach(async () => {
  bridge.invoke.mockClear()
  bridge.eventOn.mockImplementation((channel, listener) => {
    expect(channel).toBe(CONTENT_CONTEXT_MENU_OPEN)
    receive = listener
    return vi.fn()
  })
  harness = createReactHarness()
  await harness.render(createNode(ContentContextMenuHost))
})
afterEach(() => harness.cleanup())

describe('themed host content menu', () => {
  it('uses the product menu, exposes disabled states and routes the captured request on selection', async () => {
    await act(async () => receive(model))
    expect(items().map(item => item.querySelector('.gg-menu-item-label')?.textContent)).toEqual(['Copy', 'Quote file'])
    expect(items()[0].getAttribute('aria-disabled')).toBe('true')
    expect(bridge.invoke).toHaveBeenCalledWith(HOST_LAYER_SHOW, true)
    expect(document.body.querySelector('[role=menu]')).toBeNull()
    expect(items()[0].querySelector('.gg-menu-item-shortcut')?.textContent).toMatch(/C/)
    await clickElement(items()[1])
    expect(bridge.invoke).toHaveBeenCalledWith(CONTENT_CONTEXT_MENU_ACTION, { requestId: 'captured', actionId: 'quote' })
    expect(bridge.invoke).toHaveBeenCalledWith(HOST_LAYER_SHOW, false)
    expect(items()).toEqual([])
  })

  it('keeps disabled shortcuts inactive and executes enabled shortcuts using the same captured action', async () => {
    await act(async () => receive(model))
    // Use the same platform parser as the real menu rather than assuming the test host OS.
    const { detectPlatform } = await import('@tanstack/react-hotkeys')
    // The layer holds the keyboard while the menu is open.
    const key = () => layer.dispatchEvent(new (layer as typeof window).KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: detectPlatform() !== 'mac', metaKey: detectPlatform() === 'mac', cancelable: true }))
    await act(async () => { key() })
    expect(bridge.invoke).not.toHaveBeenCalledWith(CONTENT_CONTEXT_MENU_ACTION, expect.anything())
    await act(async () => receive({ ...model, requestId: 'enabled', items: [{ id: 'copy', label: 'Copy', hotkey: 'Mod+C' }] }))
    await act(async () => { key() })
    expect(bridge.invoke).toHaveBeenCalledWith(CONTENT_CONTEXT_MENU_ACTION, { requestId: 'enabled', actionId: 'copy' })
  })
})
