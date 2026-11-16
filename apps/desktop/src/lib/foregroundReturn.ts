import { platform } from '../platform'
import { readOnReturn } from './replica'

/**
 * A return to the app, once per return: having left (no Gugu window has the focus — the host's answer, main.ts
 * @@@app-active — or the page hidden), coming back. Focus moving inside the app (into an App's page, to another Gugu
 * window) is no return; the page becoming visible and the window gaining focus in one return read once.
 */
export function installReadOnReturn(): void {
  readOnReturn((back) => {
    let away = false
    const leave = (): void => { away = true }
    const arrive = (): void => {
      if (!away) return
      away = false
      back()
    }
    const visibility = (): void => (document.visibilityState === 'hidden' ? leave() : arrive())
    document.addEventListener('visibilitychange', visibility)
    const stopHost = platform.subscribeAppActive?.((active) => (active ? arrive() : leave()))
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      stopHost?.()
    }
  })
}
