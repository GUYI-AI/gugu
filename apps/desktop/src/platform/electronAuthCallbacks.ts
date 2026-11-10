import { OpenedLinkInbox } from '../../shared/opened-link-inbox'
import { isOAuthCallback } from '../../shared/oauth-callback'
import { rememberReferrerFromLink } from '../lib/referral'
import { unavailableCapability } from './errors'
import type { AppPlatform } from './types'

const inbox = new OpenedLinkInbox()
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
    const urls = await api.invoke('auth:take-callbacks')
    if (!Array.isArray(urls) || !urls.every((url) => typeof url === 'string')) throw new Error('Invalid OAuth callback delivery')
    // Main shows this window every link the OS opened (Android: capacitorOpenedLinks). Login takes the OAuth
    // callbacks; an invite's referrer is remembered before sign-up; the rest is main's to open.
    for (const url of urls as string[]) {
      rememberReferrerFromLink(url)
      if (isOAuthCallback(url)) inbox.push(url)
    }
  }
  // Kept for this renderer's lifetime, so a StrictMode remount never discards a drained URL.
  if (!listening) {
    api.eventOn('auth:callback-available', () => {
      void take().catch((error: unknown) => { ready = null; for (const report of errors) report(error) })
    })
    listening = true
  }
  ready = take().catch((error: unknown) => { ready = null; throw error })
  return ready
}
export const electronAuthCallbacks: NonNullable<AppPlatform['authCallbacks']> = {
  async redirectTo() {
    const value = await bridge().invoke('auth:oauth-redirect')
    if (typeof value !== 'string') throw new Error('Invalid OAuth callback URL')
    return value
  },
  ready: async () => startSource(),
  subscribe(listener, onError) {
    let active = true
    errors.add(onError)
    const unsubscribe = inbox.subscribe('auth', listener)
    void Promise.resolve().then(startSource).catch((error: unknown) => { if (active) onError(error) })
    return () => { active = false; unsubscribe(); errors.delete(onError) }
  },
}
