import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { egress } from '@gugu/core/shared/egress'
import { pauseElectronRealtimeChannels, reconnectElectronRealtimeChannels } from './realtime-channel'
import { createLogger } from './lib/logger'

/** Observes the egress fetch of the main process's cloud clients: an answer below 500 is a transport fact. */
const observeCloudAnswers = (next: typeof globalThis.fetch) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await next(input, init)
  if (response.status < 500) for (const listener of cloudAnswerListeners) listener()
  return response
}) as typeof globalThis.fetch

/** The egress fetch plus the cloud-answer listeners, for callers outside a supabase client (MCP tools, model access). */
export const electronFetch = observeCloudAnswers(((input: RequestInfo | URL, init?: RequestInit) => egress.fetch(input as string | URL | Request, init)) as typeof globalThis.fetch)

const cloudAnswerListeners = new Set<() => void>()

/**
 * The backend answered a main-process cloud request (any status below 500). Work deferred because the cloud
 * was unreachable resumes on this transport fact, not on a timer. Listeners must stay cheap and synchronous.
 */
export function onElectronCloudAnswer(listener: () => void): () => void {
  cloudAnswerListeners.add(listener)
  return () => { cloudAnswerListeners.delete(listener) }
}

// Construct lazily: merely importing this module (e.g. from contract-check
// tooling that has no Supabase env) must not build a client. The env
// requirement (no hardcoded fallback) is enforced on first real use, not at
// import time.
type ElectronSupabaseClient = ReturnType<typeof createGuguSupabaseClient>
let currentAccessToken: ((forceRefresh?: boolean) => Promise<string | null>) | null = null

/** 账号拥有登录态;频道只从这里现取,不能各自保存一枚令牌去改整条共享连接。 */
export function bindElectronSupabaseAuth(provider: (forceRefresh?: boolean) => Promise<string | null>): void {
  currentAccessToken = provider
}

export async function refreshElectronSupabaseAuth(): Promise<void> {
  await cachedSupabase?.realtime.setAuth()
}

/** A suspended kernel preserves sockets that the server has already dropped.
 * Close them proactively; inbox REST reconciliation runs independently. */
let resumeFlight: Promise<void> | null = null
export function resumeElectronSupabaseRealtime(): Promise<void> {
  if (resumeFlight) return resumeFlight
  const client = cachedSupabase, account = currentAccessToken
  if (!client || !account) return Promise.resolve()
  const run = (async () => {
    const release = pauseElectronRealtimeChannels()
    try {
      await client.realtime.disconnect()
      let attempt = 0
      while (cachedSupabase === client && currentAccessToken === account) {
        try {
          // Realtime catches callback errors and reuses its cached JWT. Refresh
          // outside that callback, with normal channel retries held behind us.
          const token = await account(true)
          if (currentAccessToken !== account || !token) return // signed out/replaced
          await client.realtime.setAuth(token)
          release()
          await reconnectElectronRealtimeChannels()
          client.realtime.connect()
          return
        } catch (error) {
          const retryMs = [1_000, 2_000, 5_000, 10_000, 30_000][Math.min(attempt++, 4)]!
          // No token or exception text: upstream errors can carry credentials.
          createLogger('host-resume/auth').warn({ attempt, retryMs, reason: error instanceof Error ? error.name : 'unknown' }, 'Resume ticket renewal will retry')
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, retryMs)
            timer.unref?.()
          })
        }
      }
    } finally { release() }
  })()
  const tracked = run.finally(() => { if (resumeFlight === tracked) resumeFlight = null })
  resumeFlight = tracked
  return tracked
}

let cachedSupabase: ElectronSupabaseClient | null = null
function resolveSupabase(): ElectronSupabaseClient {
  return (cachedSupabase ??= createGuguSupabaseClient({
    accessToken: async () => {
      if (!currentAccessToken) throw new Error('Electron Supabase account provider is not bound')
      return currentAccessToken()
    },
    wrapFetch: observeCloudAnswers
  }))
}

export const supabase = new Proxy({} as ElectronSupabaseClient, {
  get(_target, prop) {
    const client = resolveSupabase() as unknown as Record<PropertyKey, unknown>
    const value = client[prop]
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(client) : value
  }
}) as ElectronSupabaseClient

/** A host-owned short-lived connection, with no stored GoTrue session or shared channel objects. */
export function createElectronRealtimeClient(accessToken: () => Promise<string | null>) {
  return createGuguSupabaseClient({ accessToken, wrapFetch: observeCloudAnswers })
}

// Returns an authenticated identity-schema client using the caller's access token.
export function makeIdentityClient(accessToken: string) {
  return createGuguSupabaseClient({
    schema: 'identity',
    wrapFetch: observeCloudAnswers,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

// Returns an authenticated chat-schema client (messages / chat_members). Used host-side for the
// thread bootstrap fetch (#1196 Q1); RLS applies (messages_view is security_invoker).
export function makeChatClient(accessToken: string) {
  return createGuguSupabaseClient({
    schema: 'chat',
    wrapFetch: observeCloudAnswers,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}
