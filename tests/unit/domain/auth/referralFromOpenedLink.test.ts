// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  signInWithOtp: vi.fn(async () => ({ error: null })),
  verifyOtp: vi.fn(async () => ({ data: { session: { access_token: 'x' }, user: { id: 'u' } }, error: null })),
  links: null as ((url: string) => void) | null,
  session: null as unknown,
  sessionListeners: new Set<() => void>(),
}))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  supabase: { auth: mocks },
  identityDb: {},
  syncSchemaClientSession: vi.fn(async () => undefined),
}))

import { authService } from '../../../../apps/desktop/src/lib/auth'
import { consumePendingReferrer, watchReferralLinks } from '../../../../apps/desktop/src/lib/referral'

const otpData = () => (mocks.signInWithOtp.mock.calls.at(-1) as unknown as [{ options: { data: Record<string, unknown> } }])[0].options.data
const opened = (url: string) => mocks.links!(url)
const watchOpenedLinks = (listener: (url: string) => void) => { mocks.links = listener; return () => { mocks.links = null } }
const sessions = {
  getSnapshot: () => ({ session: mocks.session }),
  subscribe: (listener: () => void) => { mocks.sessionListeners.add(listener); return () => { mocks.sessionListeners.delete(listener) } },
}
const watch = () => watchReferralLinks(watchOpenedLinks, sessions)
const signIn = (session: unknown) => { mocks.session = session; for (const listener of mocks.sessionListeners) listener() }

// The referral link is the personal short code (qrPayload @@@short-qr). The OS hands it to the App before
// sign-up (official /j/ page → gugu://…/j/?<n>); email sign-up then carries it in user metadata, which
// billing.claim_device_free_credits reads to grant the referral reward.
describe('referral from a link the OS opened', () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); mocks.session = null; mocks.sessionListeners.clear() })

  it('a contact short link opened while signed out becomes the sign-up referrer, and signing in clears it', async () => {
    const stop = watch()
    opened('gugu://gugu.nextmind.space/j/?123456789')
    await authService.requestLoginOtp('new@example.test')
    expect(otpData().referrer_gugu_number).toBe('123456789')
    signIn({ access_token: 'x' })
    expect(consumePendingReferrer()).toBeNull()
    stop()
  })

  it('a contact link opened while signed in is a friend link, not a referral', () => {
    const stop = watch()
    signIn({ access_token: 'x' })
    opened('gugu://gugu.nextmind.space/j/?42')
    expect(consumePendingReferrer()).toBeNull()
    stop()
  })

  it('group invites and other links leave the referrer alone', async () => {
    const stop = watch()
    opened('https://gugu.nextmind.space/j/?208803.n4bQgYhMfWWaL-qgxVrQFQ')
    opened('gugu://chat/00000000-0000-4000-8000-000000000001')
    opened('https://example.com/?ref=7')
    expect(consumePendingReferrer()).toBeNull()
    await authService.requestLoginOtp('new@example.test')
    expect(otpData()).not.toHaveProperty('referrer_gugu_number')
    stop()
  })
})
