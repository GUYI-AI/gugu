import { platform } from '../platform'
import { readOnReturn } from './replica'

/**
 * How long "no Gugu window has the focus" must last to be leaving: switching between two Gugu windows blurs one before
 * focusing the other (main.ts @@@app-active answers "none" in between), which is no leaving.
 */
export const LEAVE_GRACE_MS = 200

/**
 * A return to the app, once per return: having left (no Gugu window has the focus for longer than LEAVE_GRACE_MS — the
 * host's answer, main.ts @@@app-active — or the page hidden), coming back. Focus moving inside the app (into an App's
 * page, to another Gugu window) is no return; the page becoming visible and the window gaining focus in one return read
 * once.
 */
export function installReadOnReturn(): void {
  readOnReturn((back) => {
    let away = false
    let leaving: ReturnType<typeof setTimeout> | undefined
    const leave = (): void => {
      clearTimeout(leaving)
      leaving = undefined
      away = true
    }
    const arrive = (): void => {
      clearTimeout(leaving)
      leaving = undefined
      if (!away) return
      away = false
      back()
    }
    const visibility = (): void => (document.visibilityState === 'hidden' ? leave() : arrive())
    document.addEventListener('visibilitychange', visibility)
    const stopHost = platform.subscribeAppActive?.((active) => {
      if (active) arrive()
      else if (leaving === undefined && !away) leaving = setTimeout(leave, LEAVE_GRACE_MS)
    })
    return () => {
      clearTimeout(leaving)
      document.removeEventListener('visibilitychange', visibility)
      stopHost?.()
    }
  })
}
