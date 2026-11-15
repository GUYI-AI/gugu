import { isOAuthCallback } from './oauth-callback'

/** The OS has one URL stream. Keep login callbacks separate from post-login navigation without
 * adding another appUrlOpen listener or losing a cold launch while the account is restoring.
 * Watchers see every link as it arrives (before and after sign-in); links that arrive before the
 * first watcher are kept for it, like a cold launch. */
export class OpenedLinkInbox {
  /** retainNavigation=false: the host opens navigation links itself (desktop main), so nobody here drains them. */
  constructor(private readonly retainNavigation = true) {}
  private readonly pending = { auth: [] as string[], navigation: [] as string[], watch: [] as string[] }
  private readonly listeners = { auth: new Set<(url: string) => void>(), navigation: new Set<(url: string) => void>() }
  private readonly watchers = new Set<(url: string) => void>()
  push(url: string): void {
    if (!this.watchers.size) this.pending.watch.push(url)
    else for (const watcher of this.watchers) watcher(url)
    const kind = isOAuthCallback(url) ? 'auth' : 'navigation'
    if (kind === 'navigation' && !this.retainNavigation) return
    const listeners = this.listeners[kind]
    if (!listeners.size) this.pending[kind].push(url)
    else for (const listener of listeners) listener(url)
  }
  clear(kind: 'auth' | 'navigation'): void { this.pending[kind].length = 0 }
  subscribe(kind: 'auth' | 'navigation', listener: (url: string) => void): () => void {
    this.listeners[kind].add(listener)
    for (const url of this.pending[kind].splice(0)) listener(url)
    return () => { this.listeners[kind].delete(listener) }
  }
  watch(listener: (url: string) => void): () => void {
    this.watchers.add(listener)
    for (const url of this.pending.watch.splice(0)) listener(url)
    return () => { this.watchers.delete(listener) }
  }
}
