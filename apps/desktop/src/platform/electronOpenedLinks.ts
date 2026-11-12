import { OpenedLinkInbox } from '../../shared/opened-link-inbox'
import { unavailableCapability } from './errors'
import type { AppPlatform } from './types'

// Main shows this window every link the OS opened (opened-links:*). Login takes the OAuth callbacks; navigation
// links are opened by main itself (handleGuguLink), so they are not kept here.
const inbox = new OpenedLinkInbox(false)
const errors = new Set<(error: unknown) => void>()
let ready: Promise<void> | null = null
let listening = false
const bridge = () => {
  const api = window.electronAPI
  if (!api) throw unavailableCapability('OAuth browser', 'electron')
  return api
}
function startSource(): Promise<void> {
  if (ready) return ready
  const api = bridge()
  const take = async () => {
    const urls = await api.invoke('opened-links:take')
    if (!Array.isArray(urls) || !urls.every((url) => typeof url === 'string')) throw new Error('Invalid opened-link delivery')
    for (const url of urls as string[]) inbox.push(url)
  }
  // Kept for this renderer's lifetime, so a StrictMode remount never discards a drained URL.
  if (!listening) {
    api.eventOn('opened-links:available', () => {
      void take().catch((error: unknown) => { ready = null; for (const report of errors) report(error) })
    })
    listening = true
  }
  ready = take().catch((error: unknown) => { ready = null; throw error })
  return ready
}
function fromSource(attach: () => () => void, onError: (error: unknown) => void): () => void {
  let active = true
  errors.add(onError)
  const detach = attach()
  void Promise.resolve().then(startSource).catch((error: unknown) => { if (active) onError(error) })
  return () => { active = false; detach(); errors.delete(onError) }
}
export const electronAuthCallbacks: NonNullable<AppPlatform['authCallbacks']> = {
  async redirectTo() {
    const value = await bridge().invoke('auth:oauth-redirect')
    if (typeof value !== 'string') throw new Error('Invalid OAuth callback URL')
    return value
  },
  ready: async () => startSource(),
  subscribe: (listener, onError) => fromSource(() => inbox.subscribe('auth', listener), onError),
}
export const watchElectronOpenedLinks: NonNullable<AppPlatform['watchOpenedLinks']> = (listener, onError) => fromSource(() => inbox.watch(listener), onError)
