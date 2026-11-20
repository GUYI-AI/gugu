import type { Session } from '@supabase/supabase-js'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { authCallbacks } from '@/lib/authCallbacks'
import { GoogleLoginFlow } from '@/lib/googleLoginFlow'
import { platform } from '@/platform'
import { MAIN_PKCE_STORAGE_KEY } from '../../../shared/auth-storage-keys'
import { googleAuthorizationUrl } from '../../../shared/google-authorization-url'
import { oauthHandoffRedirect } from '../../../shared/oauth-attempt'
import { TeamApiError } from './errors'
import type { TeamApi, TeamSignInResult } from './types'

/** A proof is deliberately a separate Auth client with memory-only storage and no main-session publisher. */
export function createTeamGoogleProof(api: TeamApi) {
  const memory = new Map<string, string>(), storageKey = `gugu-team-google-proof-${crypto.randomUUID()}`
  const proofClient = createGuguSupabaseClient({ storageKey, persistSession: true, autoRefreshToken: false, flowType: 'pkce',
    storage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => { memory.set(key, value) }, removeItem: key => { memory.delete(key) } } })
  let proof: Session | null = null, expiresAt = 0, generation = 0, flow: GoogleLoginFlow | null = null
  const stops: Array<() => void> = []
  let rejectPending: ((cause: unknown) => void) | null = null
  async function discard() {
    proof = null; expiresAt = 0
    // Scope local affects this temporary proof only, never another personal device's session.
    await proofClient.auth.signOut({ scope: 'local' }).catch(() => undefined)
    memory.clear()
  }
  async function exchange(teamId?: string): Promise<TeamSignInResult> {
    if (!proof || Date.now() >= expiresAt) { await discard(); throw new TeamApiError('verification_expired') }
    const observed = generation
    try {
      const result = await api.googleSignIn(proof, teamId)
      if (observed !== generation) throw new TeamApiError('verification_expired')
      await discard()
      return result
    } catch (cause) {
      if (!(cause instanceof TeamApiError) || cause.code !== 'context_required') await discard()
      throw cause
    }
  }
  async function cancel() {
    ++generation
    rejectPending?.(new TeamApiError('google_cancelled')); rejectPending = null
    await flow?.cancel(); flow = null
    for (const stop of stops.splice(0)) stop()
    await discard()
  }
  return {
    async start() {
      await cancel()
      const observed = generation, browser = platform.oauthBrowser
      if (!browser || !platform.authCallbacks) throw new TeamApiError('google_unavailable')
      await authCallbacks.ready()
      const redirectTo = await authCallbacks.redirectTo()
      const proved = new Promise<void>((resolve, reject) => {
        rejectPending = reject
        flow = new GoogleLoginFlow({
          storage: { getItem: async key => memory.get(key === MAIN_PKCE_STORAGE_KEY ? `${storageKey}-code-verifier` : key) ?? null,
            setItem: async (key, value) => { memory.set(key === MAIN_PKCE_STORAGE_KEY ? `${storageKey}-code-verifier` : key, value) },
            removeItem: async key => { memory.delete(key === MAIN_PKCE_STORAGE_KEY ? `${storageKey}-code-verifier` : key) } },
          redirectTo, begin: () => observed,
          signIn: callback => proofClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: oauthHandoffRedirect(callback), skipBrowserRedirect: true } }),
          exchange: code => proofClient.auth.exchangeCodeForSession(code),
          openBrowser: (url, callback) => browser.openBrowser(googleAuthorizationUrl(url, getSupabaseUrl(), oauthHandoffRedirect(callback))),
          accept: async (_attempt, session) => {
            if (generation !== observed) throw new TeamApiError('google_cancelled')
            proof = session; expiresAt = Date.now() + 5 * 60_000; resolve()
          },
        })
        stops.push(flow.subscribe(() => {
          if (flow?.getSnapshot().phase === 'failed') reject(new TeamApiError('google_failed'))
        }))
      })
      // Install a rejection observer before native registration awaits (a close may arrive immediately).
      void proved.catch(() => undefined)
      try {
        stops.push(authCallbacks.subscribe(url => { void flow?.callback(url) }, () => flow?.callbackUnavailable()))
        if (browser.subscribeBrowserFinished) stops.push(await browser.subscribeBrowserFinished(() => flow?.browserFinished(), () => flow?.callbackUnavailable()))
        if (generation !== observed) throw new TeamApiError('google_cancelled')
        await flow!.start(); await proved
        return await exchange()
      } finally {
        rejectPending = null
        for (const stop of stops.splice(0)) stop()
      }
    },
    choose: exchange,
    cancel,
  }
}
