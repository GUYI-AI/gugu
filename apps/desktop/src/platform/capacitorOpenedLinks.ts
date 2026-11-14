import { App } from '@capacitor/app'
import { OpenedLinkInbox } from '../../shared/opened-link-inbox'

const inbox = new OpenedLinkInbox()
let source: Promise<void> | null = null

export function nativeOpenedLinksReady(): Promise<void> {
  if (!source) source = Promise.resolve().then(() => App.addListener('appUrlOpen', (event) => inbox.push(event.url))).then(() => undefined, (error: unknown) => {
    source = null
    throw error
  })
  return source
}

/** One native listener for the lifetime of the app. AppPlugin retains the initial appUrlOpen
 * intent; subsequent component subscriptions drain the matching inbox, including before login. */
export function subscribeNativeOpenedLinks(kind: 'auth' | 'navigation', listener: (url: string) => void, onError: (error: unknown) => void): () => void {
  return fromNativeSource(() => inbox.subscribe(kind, listener), onError)
}

/** Every link the OS hands the App, as it arrives (before and after sign-in). */
export function watchNativeOpenedLinks(listener: (url: string) => void, onError: (error: unknown) => void): () => void {
  return fromNativeSource(() => inbox.watch(listener), onError)
}

function fromNativeSource(attach: () => () => void, onError: (error: unknown) => void): () => void {
  let active = true
  const detach = attach()
  void nativeOpenedLinksReady().catch((error: unknown) => { if (active) onError(error) })
  return () => { active = false; detach() }
}
