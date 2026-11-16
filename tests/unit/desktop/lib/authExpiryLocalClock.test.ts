// @vitest-environment jsdom
// A PC whose clock is off from GoTrue's by more than the token lifetime: every token GoTrue issues must still be
// judged by the local clock, or the "can't reach the server" banner shows, the refresh schedule collapses to its 1s
// floor, and a restart reuses a refresh token.
import { createClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authBoundedFetch } from '../../../../apps/desktop/src/lib/authBoundedFetch'
import { isSessionPastExpiry } from '../../../../apps/desktop/src/lib/sessionExpiryModel'

const LIFETIME_S = 3600
const user = { id: 'user-a', aud: 'authenticated', role: 'authenticated', email: 'a@example.test',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' }

function gotrueAnswering(serverSkewMs: number) {
  return vi.fn(async () => {
    const serverNowS = Math.floor((Date.now() + serverSkewMs) / 1000)
    return new Response(JSON.stringify({
      access_token: 'header.payload.sig', token_type: 'bearer', refresh_token: 'refresh-2',
      expires_in: LIFETIME_S, expires_at: serverNowS + LIFETIME_S, user,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
}

async function refreshedSession() {
  const client = createClient('https://backend.example.test', 'anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: authBoundedFetch },
  })
  const { data, error } = await client.auth.refreshSession({ refresh_token: 'refresh-1' })
  expect(error).toBeNull()
  return data.session!
}

afterEach(() => { vi.unstubAllGlobals() })

describe('session expiry follows the local clock', () => {
  for (const [label, skewMs] of [['local clock 257 min fast', -257 * 60_000], ['local clock 4 h slow', 4 * 3_600_000]] as const) {
    it(`${label}: a fresh token is valid for its lifetime on this machine`, async () => {
      vi.stubGlobal('fetch', gotrueAnswering(skewMs))
      const session = await refreshedSession()
      const remainingMs = session.expires_at! * 1000 - Date.now()
      expect(remainingMs).toBeGreaterThan((LIFETIME_S - 5) * 1000)
      expect(remainingMs).toBeLessThanOrEqual((LIFETIME_S + 1) * 1000) // auth-js rounds receipt time to the second
      expect(isSessionPastExpiry(session, Date.now())).toBe(false)
    })
  }

  it('passes non-session auth responses through untouched', async () => {
    const body = JSON.stringify({ code: 'otp_expired', msg: 'Token has expired' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 403, headers: { 'content-type': 'application/json' } })))
    const response = await authBoundedFetch('https://backend.example.test/auth/v1/verify', { method: 'POST' })
    expect(response.status).toBe(403)
    expect(await response.text()).toBe(body)
  })
})
