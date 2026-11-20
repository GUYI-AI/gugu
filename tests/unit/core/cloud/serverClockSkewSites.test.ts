// A device clock far off the backend's (the reported PC ran 4 h 17 min fast) must not make the times the backend or
// another device issued look expired, or still valid, here. Each case: this device's clock is skewed, one answer from
// the backend has been read into the runtime's `serverNow()`, then a real call site decides.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withServerClock } from '@gugu/core/shared/serverClock'
import { createDeviceActionHost } from '@gugu/core/cloud/deviceActionHost'
import { readDeviceActionResult } from '@gugu/core/shared/deviceActions'
import { createRefreshingRuntimeAuthProvider } from '@gugu/core/cloud/runtimeAuthProvider'

vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseAnonKey: () => 'public-anon-key',
  getSupabaseUrl: () => 'https://db.example.test',
}))
const { platformModelIsExpired } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model')

const SERVER = Date.parse('2026-11-16T12:00:00.000Z')
const SKEWS = [['4 h 17 min fast', (4 * 60 + 17) * 60_000], ['4 h slow', -4 * 60 * 60_000]] as const

/** This device's clock reads `skew` off, and it has had one answer from the backend. */
async function skewedDevice(skew: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(SERVER + skew)
  await withServerClock(async (_url: string) => new Response('[]', { headers: { date: new Date(SERVER).toUTCString() } }))('https://db.example.test/rest/v1/ping')
}
const iso = (offsetMs: number) => new Date(SERVER + offsetMs).toISOString()

afterEach(() => { vi.useRealTimers() })

describe.each(SKEWS)('device clock %s', (_name, skew) => {
  it('a platform model ticket the issuer gave 15 minutes is live, and one past its expiry is not', async () => {
    await skewedDevice(skew)
    expect(platformModelIsExpired({ expiresAt: iso(15 * 60_000) })).toBe(false)
    expect(platformModelIsExpired({ expiresAt: iso(-1_000) })).toBe(true)
  })

  it('a device action stamped by a caller whose clock is right is still in time here', async () => {
    await skewedDevice(skew)
    let runs = 0
    const host = createDeviceActionHost({
      provider: { manifest: () => [], permit: () => ({ ok: true }), run: async () => { runs += 1; return { ok: true, data: null } } },
      publishEvent: () => undefined,
    })
    try {
      const fresh = await host.handleCall({ v: 1, call_id: 'fresh', action: 'calendar.events.create', args: {}, timeout_ms: 30_000, deadline_at: iso(25_000) })
      const late = await host.handleCall({ v: 1, call_id: 'late', action: 'calendar.events.create', args: {}, timeout_ms: 30_000, deadline_at: iso(-1_000) })
      await vi.waitFor(() => expect(runs).toBe(1))
      expect(fresh.result).toMatchObject({ call_id: 'fresh', state: 'accepted' })
      expect(readDeviceActionResult(late.result)).toMatchObject({ ok: false, code: 'expired' })
    } finally { host.dispose() }
  })

  it('a headless host serves its fresh owner token instead of refreshing on every read', async () => {
    await skewedDevice(skew)
    const claims = Buffer.from(JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', exp: Math.floor((SERVER + 3_600_000) / 1000) })).toString('base64url')
    let refreshes = 0
    const provider = createRefreshingRuntimeAuthProvider({
      supabaseUrl: 'https://db.example.test',
      anonKey: 'anon',
      accessToken: `h.${claims}.s`,
      refreshToken: 'r1',
      fetchImpl: async () => { refreshes += 1; return new Response('{}', { status: 500 }) },
    })
    await expect(provider.getAuth()).resolves.toMatchObject({ accessToken: `h.${claims}.s` })
    expect(refreshes).toBe(0)
  })

  it('a headless host refreshes an owner token the backend already counts as expired', async () => {
    await skewedDevice(skew)
    const claims = Buffer.from(JSON.stringify({ sub: '11111111-1111-4111-8111-111111111111', exp: Math.floor((SERVER - 600_000) / 1000) })).toString('base64url')
    let refreshes = 0
    const provider = createRefreshingRuntimeAuthProvider({
      supabaseUrl: 'https://db.example.test',
      anonKey: 'anon',
      accessToken: `h.${claims}.s`,
      refreshToken: 'r1',
      fetchImpl: async () => { refreshes += 1; return new Response('{}', { status: 500 }) },
    })
    await expect(provider.getAuth()).rejects.toThrow(/refresh failed/)
    expect(refreshes).toBe(1)
  })
})
