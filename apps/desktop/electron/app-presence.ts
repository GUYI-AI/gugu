import { app, BrowserWindow } from 'electron'

/**
 * @@@app-presence — whether the person is in Gugu, for the reads made on a return (renderer lib/foregroundReturn.ts; the
 * chat's read marks use @@@app-active, not this). Switching between Gugu's own windows is no leaving: on macOS the app's
 * own resign / become active (its own windows do not fire them); elsewhere no Gugu window focused for 200 ms (a switch
 * blurs one window before focusing the next). It starts from the real state — a Gugu window focused now — ❌ assumed here:
 * an app started in the background (at login, after an update, switched away during start) would otherwise take its
 * first return for no change, and nothing would be read.
 */
export function followAppPresence(send: (present: boolean) => void): { present: () => boolean } {
  const focused = (): boolean => BrowserWindow.getFocusedWindow() !== null
  let present = focused()
  const set = (next: boolean): void => {
    if (next === present) return
    present = next
    send(next)
  }
  // A Gugu window focused: in Gugu, whatever the platform (a launch in the foreground says so this way too).
  app.on('browser-window-focus', () => set(true))
  if (process.platform === 'darwin') {
    app.on('did-resign-active', () => set(false))
    app.on('did-become-active', () => set(true))
  } else {
    let leaving: ReturnType<typeof setTimeout> | undefined
    app.on('browser-window-blur', () => {
      clearTimeout(leaving)
      leaving = setTimeout(() => { if (!focused()) set(false) }, 200)
    })
    app.on('browser-window-focus', () => clearTimeout(leaving))
  }
  return { present: () => present }
}
