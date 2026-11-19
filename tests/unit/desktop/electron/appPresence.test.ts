import { afterEach, describe, expect, it, vi } from 'vitest'
import { followAppPresence } from '../../../../apps/desktop/electron/app-presence'

/**
 * @@@app-presence: in Gugu or not, for the reads made on a return. It starts from the real state (a Gugu window focused
 * now): an app started in the background (at login, after an update) must take its first return as a return.
 */
function host(platform: NodeJS.Platform, focusedAtStart: boolean) {
  const listeners = new Map<string, (() => void)[]>()
  let focused = focusedAtStart
  const sent: boolean[] = []
  const presence = followAppPresence({
    platform,
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    focused: () => focused,
    send: (present) => { sent.push(present) },
  })
  const emit = (event: string) => (listeners.get(event) ?? []).forEach((listener) => listener())
  return { presence, sent, emit, focus: (next: boolean) => { focused = next } }
}

afterEach(() => { vi.useRealTimers() })

describe('app presence', () => {
  it('started in the background (macOS): not present, and the first return is a change', () => {
    const app = host('darwin', false)
    expect(app.presence.present()).toBe(false)
    app.focus(true)
    app.emit('did-become-active')
    expect(app.sent).toEqual([true])
    expect(app.presence.present()).toBe(true)
  })

  it('started in the foreground: present; told present again, nothing is sent', () => {
    const app = host('darwin', true)
    expect(app.presence.present()).toBe(true)
    app.emit('did-become-active')
    app.emit('browser-window-focus')
    expect(app.sent).toEqual([])
  })

  it('a Gugu window focused says present on every platform (a launch whose "became active" came before anyone listened)', () => {
    const mac = host('darwin', false)
    mac.focus(true)
    mac.emit('browser-window-focus')
    expect(mac.sent).toEqual([true])
    const win = host('win32', false)
    win.focus(true)
    win.emit('browser-window-focus')
    expect(win.sent).toEqual([true])
  })

  it('elsewhere: leaving needs no Gugu window focused for the confirmation time (a switch between Gugu windows is no leaving)', () => {
    vi.useFakeTimers()
    const app = host('linux', true)
    app.focus(false)
    app.emit('browser-window-blur')
    app.focus(true)
    app.emit('browser-window-focus')
    vi.advanceTimersByTime(500)
    expect(app.sent).toEqual([])
    app.focus(false)
    app.emit('browser-window-blur')
    vi.advanceTimersByTime(500)
    expect(app.sent).toEqual([false])
  })
})
