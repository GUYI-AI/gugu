import { platform } from '../platform'
import { readOnReturn } from './replica'

/**
 * A return to the app, once per return: the person left (the desktop's app presence, main.ts @@@app-presence — switching
 * between Gugu windows is no leaving; a phone's app state; elsewhere the page hidden) and came back. Focus moving inside
 * the app is no return.
 */
export function installReadOnReturn(): void {
  readOnReturn((back) => {
    let away = false
    const follow = (present: boolean): void => {
      if (!present) { away = true; return }
      if (!away) return
      away = false
      back()
    }
    const host = platform.subscribeAppPresence ?? platform.subscribeAppActive
    if (host) return host(follow)
    const visibility = (): void => follow(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  })
}
