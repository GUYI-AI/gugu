// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReferralLink, normalizeReferralCode, parseReferralLink } from '../../../../packages/core/src/shared/referralLink'

const state = vi.hoisted(() => ({ user: 'new-user', rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  getCurrentAuthUserId: async () => state.user,
  dataClient: { schema: () => ({ rpc: state.rpc }) },
}))
import { claimMyReferral, getMyReferral, readReferralSummary } from '../../../../apps/desktop/src/lib/referrals'
import { clearPersonalReferral, pendingPersonalReferral, rememberPersonalReferral } from '../../../../apps/desktop/src/lib/referralPending'

const summary = () => ({ status: 'ok', code: 'ABCDEF123456', code_enabled: true, successful_invitations: 2,
  rewarded_invitations: 1, earned_cny: '2.75', claim_available: true, claim_deadline: '2026-12-01T00:00:00Z',
  attribution: null, policy: { rewards_enabled: true, credits_each_cny: '2.75', recipients: 'invitee',
    success_condition: 'first_message', max_rewards_per_inviter: null } })
beforeEach(() => { localStorage.clear(); state.user = 'new-user'; state.rpc.mockReset() })

describe('personal referral transport', () => {
  it('uses a separate link format and rejects duplicate params and untrusted hosts', () => {
    expect(createReferralLink('abcdef123456')).toBe('https://gugu.nextmind.space/j/?r=ABCDEF123456')
    expect(parseReferralLink('gugu://gugu.nextmind.space/j/?r=ABCDEF123456')).toBe('ABCDEF123456')
    expect(parseReferralLink('https://gugu.nextmind.space/j/?123456')).toBeNull()
    expect(parseReferralLink('https://evil.test/j/?r=ABCDEF123456')).toBeNull()
    expect(parseReferralLink('https://gugu.nextmind.space/j/?r=ABCDEF123456&r=ABCDEF123456')).toBeNull()
    expect(normalizeReferralCode('5')).toBeNull()
  })
  it('binds a prelogin code to the reviewing account, not a later login', () => {
    rememberPersonalReferral('ABCDEF123456')
    expect(pendingPersonalReferral('first')).toBe('ABCDEF123456')
    expect(pendingPersonalReferral('second')).toBe('')
    clearPersonalReferral('second')
    expect(pendingPersonalReferral('first')).toBe('ABCDEF123456')
    clearPersonalReferral('first')
    expect(pendingPersonalReferral('first')).toBe('')
  })
  it('preserves server values and rejects partial responses instead of substituting zero', () => {
    expect(readReferralSummary(summary()).successful_invitations).toBe(2)
    expect(readReferralSummary(summary()).policy.max_rewards_per_inviter).toBeNull()
    expect(() => readReferralSummary({ status: 'ok' })).toThrow()
    expect(() => readReferralSummary({ ...summary(), successful_invitations: null })).toThrow()
    expect(() => readReferralSummary({ ...summary(), earned_cny: 'NaN' })).toThrow()
  })
  it('uses the current authenticated account and refuses stale-account results', async () => {
    state.rpc.mockResolvedValue({ data: summary(), error: null })
    expect((await getMyReferral('new-user')).successful_invitations).toBe(2)
    state.rpc.mockImplementation(async () => { state.user = 'other'; return { data: summary(), error: null } })
    await expect(getMyReferral('new-user')).rejects.toThrow('account changed')
  })
  it('retains RPC failures and only accepts explicit server claim results', async () => {
    state.rpc.mockResolvedValue({ data: null, error: new Error('offline') })
    await expect(claimMyReferral('new-user','ABCDEF123456')).rejects.toThrow('offline')
    state.rpc.mockResolvedValue({ data: { status: 'source_locked' }, error: null })
    expect(await claimMyReferral('new-user','ABCDEF123456')).toBe('source_locked')
    state.rpc.mockResolvedValue({ data: {}, error: null })
    await expect(claimMyReferral('new-user','ABCDEF123456')).rejects.toThrow('invalid response')
  })
})
