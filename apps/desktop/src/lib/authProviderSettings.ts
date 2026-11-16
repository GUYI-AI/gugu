import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { replica } from './replica'
export const AUTH_SETTINGS_TIMEOUT_MS = 2_000

/** Public backend capabilities only. Rejects on a failed answer or past the whole fetch/body deadline (❌ a false "not
 * enabled"); this never reads or writes a user session, or changes provider configuration. */
export function readGoogleProviderEnabled(url: string, anonKey: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis), signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let settled = false
    const finish = (outcome: { enabled: boolean } | { error: Error }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
      controller.abort()
      if ('error' in outcome) reject(outcome.error)
      else resolve(outcome.enabled)
    }
    const cancelled = () => finish({ error: new Error('Reading the sign-in methods was cancelled') })
    const timer = setTimeout(() => finish({ error: new Error(`The sign-in methods did not answer within ${AUTH_SETTINGS_TIMEOUT_MS} ms`) }), AUTH_SETTINGS_TIMEOUT_MS)
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) { cancelled(); return }
    void (async () => {
      try {
        const response = await request(`${url.replace(/\/+$/, '')}/auth/v1/settings`, {
          headers: { apikey: anonKey, Accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) { finish({ error: new Error(`Reading the sign-in methods failed: HTTP ${response.status}`) }); return }
        const data: unknown = await response.json()
        const external = data && typeof data === 'object' ? (data as { external?: unknown }).external : null
        finish({ enabled: Boolean(external && typeof external === 'object' && (external as { google?: unknown }).google === true) })
      } catch (error) { finish({ error: error instanceof Error ? error : new Error(String(error)) }) }
    })()
  })
}

/** Whether this backend offers Google sign-in (device scope: read before sign-in); kept so the first frame draws it. */
export const googleProviderEnabled = replica({
  name: 'googleProviderEnabled',
  scope: 'device',
  read: () => readGoogleProviderEnabled(getSupabaseUrl(), getSupabaseAnonKey()),
  fresh: 10 * 60_000,
  persist: { maxBytes: 128, maxEntries: 1 },
})
