// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { APP_TOAST_INTERVAL_MS } from '../../../../apps/desktop/src/session/shared/extensions/bridge-protocol'
import { forgetToastsForTest } from '../../../../apps/desktop/src/session/shared/extensions/app-toast'

/**
 * #1925 (44) `gugu.toast` on a phone (API 49): the host's own toast, by the desktop's rule (app-toast.ts) — the text alone,
 * only while the App's frame is laid out and the app is in front, at most one every APP_TOAST_INTERVAL_MS.
 */

const ORIGIN = 'https://board.acct.apps.gugu.invalid'
const shown = vi.hoisted(() => [] as unknown[])
vi.mock('../../../../apps/desktop/src/session/renderer/lib/hooks/use-toast', () => ({ toast: (detail: unknown) => { shown.push(detail) } }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { manifests: [], icons: {}, isEnabled: () => true, manifestFor: () => ({ id: 'board', name: 'Board' }) } }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => null }))
vi.mock('../../../../apps/desktop/src/store/devicesCache', () => ({ readCachedDevices: () => [] }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchSessionsList: vi.fn() }))

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
let laidOut = true
beforeEach(() => {
  shown.length = 0
  forgetToastsForTest()
  laidOut = true
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  // jsdom lays nothing out: the frame says where it is as a laid-out one would.
  Object.defineProperty(frame, 'offsetParent', { get: () => (laidOut ? document.body : null), configurable: true })
  Object.defineProperty(frame, 'clientWidth', { get: () => (laidOut ? 412 : 0), configurable: true })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  host = hostAppFrame(frame, { extensionId: 'board', tabId: 'tab-1', tabName: 'main', chatId: null, capabilities: [], locale: 'en-US', themeMode: 'light' },
    { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome: vi.fn() })
})
afterEach(() => {
  host?.dispose()
  host = undefined
  vi.restoreAllMocks()
  frame.remove()
})

let nextId = 1
async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args, gesture: false }, source: frame.contentWindow, origin: ORIGIN }))
  await vi.waitFor(() => expect(posted.mock.calls.some(([message]) => (message as { id?: number }).id === id)).toBe(true))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}

describe('gugu.toast on a phone', () => {
  it('shows the text alone in the phone\'s own toast, once per interval for each App', async () => {
    expect(await call('toast', { text: '  Saved ' })).toMatchObject({ ok: true })
    expect(shown).toEqual([{ title: 'Saved' }])
    expect(await call('toast', { text: 'Again' })).toMatchObject({ ok: false, code: 'rate-limited' })
    expect(shown).toHaveLength(1)
    expect(APP_TOAST_INTERVAL_MS).toBeGreaterThan(0)
  })

  it('refuses while the frame is not laid out or the app is not in front, and a text that is not one line', async () => {
    laidOut = false
    expect(await call('toast', { text: 'Saved' })).toMatchObject({ ok: false, code: 'denied' })
    laidOut = true
    vi.mocked(document.hasFocus).mockReturnValue(false)
    expect(await call('toast', { text: 'Saved' })).toMatchObject({ ok: false, code: 'denied' })
    vi.mocked(document.hasFocus).mockReturnValue(true)
    expect(await call('toast', { text: 'two\nlines' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('toast', { text: '' })).toMatchObject({ ok: false, code: 'invalid' })
    expect(shown).toEqual([])
  })
})
