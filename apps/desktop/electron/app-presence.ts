/**
 * @@@app-presence — whether the person is in Gugu, for the reads made on a return (renderer lib/foregroundReturn.ts; the
 * chat's read marks use @@@app-active, not this). Switching between Gugu's own windows is no leaving: on macOS the app's
 * own resign / become active (its own windows do not fire them); elsewhere no Gugu window focused for `confirmMs` (a switch
 * blurs one window before focusing the next). It starts from the real state — a Gugu window focused now — ❌ assumed here:
 * an app started in the background (at login, after an update, switched away during start) would otherwise take its
 * first return for no change, and nothing would be read.
 */
export function followAppPresence(deps: {
  platform: NodeJS.Platform
  on: (event: 'did-resign-active' | 'did-become-active' | 'browser-window-blur' | 'browser-window-focus', listener: () => void) => void
  focused: () => boolean
  send: (present: boolean) => void
  confirmMs?: number
}): { present: () => boolean } {
  let present = deps.focused()
  const set = (next: boolean): void => {
    if (next === present) return
    present = next
    deps.send(next)
  }
  // A Gugu window focused: in Gugu, whatever the platform (a launch in the foreground says so this way too).
  deps.on('browser-window-focus', () => set(true))
  if (deps.platform === 'darwin') {
    deps.on('did-resign-active', () => set(false))
    deps.on('did-become-active', () => set(true))
  } else {
    let leaving: ReturnType<typeof setTimeout> | undefined
    deps.on('browser-window-blur', () => {
      clearTimeout(leaving)
      leaving = setTimeout(() => { if (!deps.focused()) set(false) }, deps.confirmMs ?? 200)
    })
    deps.on('browser-window-focus', () => clearTimeout(leaving))
  }
  return { present: () => present }
}
