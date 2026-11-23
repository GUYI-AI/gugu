// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUICK_CHAT_CHANNELS } from '../../../../apps/desktop/src/lib/quickChatIpc'
import { QuickChatHost } from '../../../../apps/desktop/src/components/assistant/QuickChatHost'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }))

let harness: ReturnType<typeof createReactHarness> | undefined
let windows: ReturnType<typeof chromiumWindows> | undefined
afterEach(() => {
  harness?.cleanup()
  windows?.dispose()
  windows = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * `window.open` as Chromium answers it for a name: the first open creates the blank window; a later open of the same
 * name hands the same window back, and with an address it also navigates it, which empties the document a moment after
 * the call returns (the navigation lands after whatever the caller wrote into the window right away).
 * `existing`: a window that already holds this name when the page asks for the first time (with content, or blank).
 */
function chromiumWindows(options: { existing?: 'blank' | 'content' } = {}) {
  const frames: HTMLIFrameElement[] = []
  const entries: { win: Window; closed: boolean }[] = []
  const opens: { url: string; name: string }[] = []
  const navigations: string[] = []
  let named: { win: Window; closed: boolean } | null = null
  const create = () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const win = frame.contentWindow!
    const entry = { win, closed: false }
    Object.defineProperty(win, 'closed', { get: () => entry.closed, configurable: true })
    // The main process turns 「close」 into 「hide」: the window stays.
    vi.spyOn(win, 'close').mockImplementation(() => {})
    frames.push(frame)
    entries.push(entry)
    return entry
  }
  if (options.existing) {
    named = create()
    if (options.existing === 'content') named.win.document.body.innerHTML = '<p data-testid="left-by-a-previous-run">previous</p>'
  }
  let onOpen: () => void = () => {}
  vi.spyOn(window, 'open').mockImplementation((url, name) => {
    opens.push({ url: String(url ?? ''), name: name ?? '' })
    if (!named || named.closed) named = create()
    else if (url) {
      navigations.push(String(url))
      const doc = named.win.document
      queueMicrotask(() => { doc.head.replaceChildren(); doc.body.replaceChildren() })
    }
    onOpen()
    return named.win
  })
  return {
    opens, navigations,
    get window() { return named!.win },
    /** The window really closes (not hidden): the main window reloaded, or it was destroyed. */
    reallyClose: () => { named!.closed = true },
    onOpen: (listener: () => void) => { onOpen = listener },
    dispose: () => { for (const entry of entries) entry.closed = true; for (const frame of frames) frame.remove() },
  }
}

function desktop() {
  const listeners = new Map<string, (value: unknown) => void>()
  const emit = (channel: string, value?: unknown) => listeners.get(channel)?.(value)
  const invoke = vi.fn(async (channel: string) => {
    if (channel === QUICK_CHAT_CHANNELS.hide) emit(QUICK_CHAT_CHANNELS.visibility, false)
    if (channel === QUICK_CHAT_CHANNELS.state) return { supported: true, enabled: true, registered: true, accelerator: 'Alt+Shift+Space' }
    return undefined
  })
  vi.stubGlobal('electronAPI', { invoke, eventOn: (channel: string, fn: (value: unknown) => void) => {
    listeners.set(channel, fn)
    return () => { listeners.delete(channel) }
  } })
  return { invoke, emit }
}

const host = () => createNode(QuickChatHost, { assistant: null, assistantState: 'none', chatId: null, chatFailed: null, retryChat: () => {} })
const show = (node: ReactNode) => renderWithAppProviders(harness!, node)

async function mount(shownDuringOpen: boolean) {
  harness = createReactHarness()
  windows = chromiumWindows()
  const ipc = desktop()
  if (shownDuringOpen) windows.onOpen(() => ipc.emit(QUICK_CHAT_CHANNELS.visibility, true))
  await show(host())
  return { child: windows.window, invoke: ipc.invoke, emit: (value: boolean) => ipc.emit(QUICK_CHAT_CHANNELS.visibility, value) }
}

describe('Quick Chat empty-state native visibility', () => {
  it('receives an immediate show notification while the native child is being adopted', async () => {
    const { child } = await mount(true)
    expect(child.document.querySelector('[data-testid="quick-chat-none"]')).not.toBeNull()
    expect(child.document.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(false)
  })

  it('keeps the pre-created empty state inert until a native show notification', async () => {
    const { child, emit } = await mount(false)
    const root = child.document.querySelector('[data-testid="quick-chat"]')!
    expect(root.hasAttribute('inert')).toBe(true)
    await act(async () => emit(true))
    expect(root.hasAttribute('inert')).toBe(false)
    await act(async () => emit(false))
    expect(root.hasAttribute('inert')).toBe(true)
  })

  it('closes the no-assistant window through its real header button', async () => {
    const { child, invoke } = await mount(true)
    const close = child.document.querySelector<HTMLButtonElement>('[data-testid="quick-chat-close"]')!
    expect(close).not.toBeNull()
    expect(close.disabled).toBe(false)
    await clickElement(close)
    expect(invoke).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.hide)
    expect(child.document.querySelector('[data-testid="quick-chat"]')?.hasAttribute('inert')).toBe(true)
  })
})
