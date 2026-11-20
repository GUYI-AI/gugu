// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { EXTENSION_PICK_DISPATCH_TARGET_METHOD } from '../../../../apps/desktop/src/session/shared/extensions/host-actions'

// An App's host action is served by the renderer that draws the App's window: the main window, or a window the main
// window opened and draws into (an App or a tab opened in a window of its own, aux-window.ts). Anything else is refused.
const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  pages: new Map<number, { id: number; getURL: () => string; opener: { contentsId: number } | null; isDestroyed: () => boolean }>(),
}))

vi.mock('electron', () => ({
  ipcMain: { on: (channel: string, handler: (...args: unknown[]) => void) => electronMock.handlers.set(channel, handler) },
  webContents: {
    fromId: (id: number) => electronMock.pages.get(id),
    fromFrame: (frame: { contentsId: number }) => electronMock.pages.get(frame.contentsId),
  },
}))

const MAIN = 42
const OWN_WINDOW = 44 // blank, opened by the main window, which draws it
const OTHER_WINDOW = 43 // a window with its own renderer
const OTHERS_BLANK = 45 // blank, but opened by the other window
for (const [id, url, opener] of [
  [MAIN, 'gugu-app://app/index.html', null],
  [OWN_WINDOW, 'about:blank', MAIN],
  [OTHER_WINDOW, 'gugu-app://app/index.html', null],
  [OTHERS_BLANK, 'about:blank', OTHER_WINDOW],
] as const) electronMock.pages.set(id, { id, getURL: () => url, opener: opener === null ? null : { contentsId: opener }, isDestroyed: () => false })

function emitIpc(channel: string, sender: unknown, payload?: unknown): void {
  electronMock.handlers.get(channel)!({ sender }, payload)
}

describe('extension host actions reach the renderer that draws the App’s window', () => {
  it('keeps the person’s pick open beyond the process deadline and still bounds ordinary host commands', async () => {
    vi.useFakeTimers()
    const events = new EventEmitter()
    try {
      const bridge = await import('../../../../apps/desktop/electron/ipc-bridge')
      bridge.setupRendererCommandIpcHandlers()
      const webContents = Object.assign(new EventEmitter(), { id: MAIN, send: vi.fn() })
      bridge.setMainWindow({ webContents, isDestroyed: () => false, once: events.once.bind(events), on: events.on.bind(events), isFullScreen: () => false } as never)
      emitIpc('extensions:cmd:ready', webContents)
      const pending = bridge.invokeRendererExtensions(EXTENSION_PICK_DISPATCH_TARGET_METHOD, {}, MAIN)
      let settled = false
      void pending.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(31_000)
      expect(settled, 'the person is still picking').toBe(false)
      const request = webContents.send.mock.calls[0][1] as { reqId: string }
      emitIpc('extensions:cmd:result', webContents, { reqId: request.reqId, result: true })
      await expect(pending).resolves.toBe(true)

      const ordinary = bridge.invokeRendererExtensions('extensions.hostAction', {}, MAIN).catch(error => error)
      await vi.advanceTimersByTimeAsync(31_000)
      expect(await ordinary).toMatchObject({ code: 'timeout' })
    } finally {
      events.emit('closed')
      vi.useRealTimers()
    }
  })

  it('serves the main window and a window of its own; refuses a window another renderer draws', async () => {
    const bridge = await import('../../../../apps/desktop/electron/ipc-bridge')
    bridge.setupRendererCommandIpcHandlers()
    const webContents = Object.assign(new EventEmitter(), { id: MAIN, send: vi.fn() })
    const events = new EventEmitter()
    bridge.setMainWindow({ webContents, isDestroyed: () => false, once: events.once.bind(events), on: events.on.bind(events), isFullScreen: () => false } as never)
    emitIpc('extensions:cmd:ready', webContents)

    const answer = async (embedderId: number) => {
      const pending = bridge.invokeRendererExtensions('extensions.hostAction', { from: embedderId }, embedderId)
      await vi.waitFor(() => expect(webContents.send.mock.calls.some(([, request]) => (request as { params: { from: number } }).params.from === embedderId)).toBe(true))
      const [, request] = webContents.send.mock.calls.find(([, sent]) => (sent as { params: { from: number } }).params.from === embedderId)!
      emitIpc('extensions:cmd:result', webContents, { reqId: (request as { reqId: string }).reqId, result: { ok: true } })
      return pending
    }

    await expect(answer(MAIN)).resolves.toEqual({ ok: true })
    await expect(answer(OWN_WINDOW)).resolves.toEqual({ ok: true })
    // Refused as `unavailable`: the App says so in its own words (workspace `failureText`), not this English.
    await expect(bridge.invokeRendererExtensions('extensions.hostAction', {}, OTHER_WINDOW)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(bridge.invokeRendererExtensions('extensions.hostAction', {}, OTHERS_BLANK)).rejects.toMatchObject({ code: 'unavailable' })
    expect(webContents.send).toHaveBeenCalledTimes(2)
  })
})
