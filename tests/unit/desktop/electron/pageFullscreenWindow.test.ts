/**
 * @@@page-fullscreen — the window follows a page into fullscreen and back, once per change, and is put back only when
 * the page put it there. (Electron itself no longer resizes the window: on macOS doing so mid-sync left gugu's page
 * holding an App's <webview> as its fullscreen element after the App's video had left.)
 */
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeWindow {
  fullScreen = false
  calls: boolean[] = []
  isDestroyed() { return false }
  isFullScreen() { return this.fullScreen }
  setFullScreen(on: boolean) { this.calls.push(on); this.fullScreen = on }
}

const owners = new Map<object, FakeWindow>()
const app = new EventEmitter()
vi.mock('electron', () => ({
  app,
  BrowserWindow: { fromWebContents: (contents: object) => owners.get(contents) ?? null },
}))

type FakeContents = EventEmitter & { hostWebContents?: FakeContents }
function contents(win: FakeWindow | null, host?: FakeContents): FakeContents {
  const c = new EventEmitter() as FakeContents
  if (win) owners.set(c, win)
  if (host) c.hostWebContents = host
  app.emit('web-contents-created', {}, c)
  return c
}

describe('page fullscreen moves the window', () => {
  beforeEach(async () => {
    owners.clear()
    const { installPageFullscreen } = await import('../../../../apps/desktop/electron/page-fullscreen')
    installPageFullscreen()
  })

  it('an App page and its embedder both report it: the window enters and leaves once', () => {
    const win = new FakeWindow()
    const host = contents(win)
    const guest = contents(null, host)
    guest.emit('enter-html-full-screen'); host.emit('enter-html-full-screen')
    expect(win.calls).toEqual([true])
    guest.emit('leave-html-full-screen'); host.emit('leave-html-full-screen')
    expect(win.calls).toEqual([true, false])
  })

  it('a window the person made fullscreen stays fullscreen after the page leaves', () => {
    const win = new FakeWindow()
    win.fullScreen = true
    const page = contents(win)
    page.emit('enter-html-full-screen'); page.emit('leave-html-full-screen')
    expect(win.calls).toEqual([])
    expect(win.fullScreen).toBe(true)
  })

  it('the page can go fullscreen again after leaving', () => {
    const win = new FakeWindow()
    const page = contents(win)
    for (let i = 0; i < 2; i++) { page.emit('enter-html-full-screen'); page.emit('leave-html-full-screen') }
    expect(win.calls).toEqual([true, false, true, false])
  })
})
