// @vitest-environment jsdom
import { StrictMode, act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QUICK_CHAT_CHANNELS, QUICK_CHAT_WINDOW_NAME } from '../../../../apps/desktop/src/lib/quickChatIpc'
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
const drawn = (win: Window) => win.document.querySelector('[data-testid="quick-chat"]')

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

// Opening is idempotent. Asking Chromium for a name that has a window navigates that window, and the navigation lands after
// what the page just wrote into it: the window is blank (D7: 39 bytes of document) with no error anywhere.
describe('Quick Chat window is opened once and what is drawn into it stays', () => {
  async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }

  it('runs its effect twice (StrictMode) with one open, no navigation, and the content intact', async () => {
    harness = createReactHarness()
    windows = chromiumWindows()
    desktop()
    // StrictMode outermost: under the providers the harness adds, React does not run the extra effect cycle.
    const strict = { ...harness, render: (node: ReactNode) => harness!.render(<StrictMode>{node}</StrictMode>) }
    await renderWithAppProviders(strict, host())
    await settle()
    // The extra cycle ran: the first run's cleanup hid the window, the second drew into it again.
    expect(windows.window.close).toHaveBeenCalledTimes(1)
    expect(drawn(windows.window)).not.toBeNull()
    expect(windows.window.document.body.children).toHaveLength(1)
    expect(windows.navigations).toEqual([])
    expect(windows.opens).toEqual([{ url: '', name: QUICK_CHAT_WINDOW_NAME }])
  })

  it('signs out and in again with the same window, hidden between, and the content intact', async () => {
    harness = createReactHarness()
    windows = chromiumWindows()
    desktop()
    await show(host())
    const win = windows.window
    expect(drawn(win)).not.toBeNull()
    await harness.render(null)
    // Signed out: nothing of it is left in the window, and the window is hidden (the main process's answer to close).
    expect(win.document.body.children).toHaveLength(0)
    expect(win.document.head.children).toHaveLength(0)
    expect(win.close).toHaveBeenCalledTimes(1)
    await show(host())
    await settle()
    expect(drawn(win)).not.toBeNull()
    expect(windows.navigations).toEqual([])
    expect(windows.window).toBe(win)
    expect(windows.opens).toHaveLength(1)
  })

  it('opens another window when the main process says the window is gone', async () => {
    harness = createReactHarness()
    windows = chromiumWindows()
    const ipc = desktop()
    await show(host())
    const first = windows.window
    windows.reallyClose()
    await act(async () => ipc.emit(QUICK_CHAT_CHANNELS.open))
    await settle()
    expect(windows.opens).toHaveLength(2)
    expect(windows.window).not.toBe(first)
    expect(drawn(windows.window)).not.toBeNull()
  })

  it('asks for a name that already has a window without an address, so it is not navigated', async () => {
    harness = createReactHarness()
    windows = chromiumWindows({ existing: 'content' })
    desktop()
    await show(host())
    await settle()
    expect(windows.navigations).toEqual([])
    expect(windows.window.document.querySelector('[data-testid="left-by-a-previous-run"]')).toBeNull()
    expect(drawn(windows.window)).not.toBeNull()
  })

  it('leaves a window it cannot draw into empty, and the page goes on', async () => {
    harness = createReactHarness()
    windows = chromiumWindows({ existing: 'blank' })
    desktop()
    const style = document.createElement('style')
    style.textContent = '.mirrored {}'
    document.head.append(style)
    // The root is the last thing written: the mirror and the body style are already in when it fails.
    const win = windows.window
    const failing = vi.spyOn(win.document.body, 'append').mockImplementation(() => { throw new Error('the window went away') })
    await show(host())
    await settle()
    expect(failing).toHaveBeenCalled()
    expect(win.document.body.children).toHaveLength(0)
    expect(win.document.head.children).toHaveLength(0)
    // Its mirror is stopped too: a style that comes to the opener later is not copied into the empty window.
    const later = document.createElement('style')
    later.textContent = '.later {}'
    document.head.append(later)
    await settle()
    expect(win.document.head.children).toHaveLength(0)
    style.remove()
    later.remove()
  })
})
