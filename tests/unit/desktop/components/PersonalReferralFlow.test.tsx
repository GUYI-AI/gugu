// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders, typeInto, clickElement } from '../../../support/testHarness'
import { i18n, setLocalePreference } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'
const rpc = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/referrals', () => ({ getMyReferral: rpc.read, claimMyReferral: rpc.claim }))
import { InvitationPanel } from '../../../../apps/desktop/src/components/referralPreview/InvitationPanel'
import { ReferralClaimField } from '../../../../apps/desktop/src/components/referralPreview/ReferralClaimField'

let harness: ReturnType<typeof createReactHarness>
const summary = () => ({ status: 'ok', code: 'ABCDEF123456', code_enabled: true, successful_invitations: 3,
  rewarded_invitations: 1, earned_cny: '2.75', claim_available: true, claim_deadline: '2026-12-01', attribution: null,
  policy: { rewards_enabled: false, credits_each_cny: '2.75', recipients: 'invitee', success_condition: 'first_message', max_rewards_per_inviter: null } })
beforeEach(async () => {
  harness = createReactHarness(); localStorage.clear(); rpc.read.mockReset(); rpc.claim.mockReset()
  setLocalePreference('zh-CN'); await i18n.changeLanguage('zh-CN')
})
afterEach(() => { harness.cleanup() })

it('shows real success and actually received credits even when rewards are disabled', async () => {
  rpc.read.mockResolvedValue(summary())
  await renderWithAppProviders(harness,createNode(InvitationPanel))
  expect(harness.container.textContent).toContain('邀请成功人数：3')
  expect(harness.container.textContent).toContain('已获得 2.75 积分')
  expect(harness.container.textContent).not.toContain('各 5')
})
it('shows an unavailable state without a fabricated zero count or enabled share buttons', async () => {
  rpc.read.mockRejectedValue(new Error('offline'))
  await renderWithAppProviders(harness,createNode(InvitationPanel))
  expect(harness.container.textContent).toContain('暂时读不到')
  expect(harness.container.textContent).not.toContain('邀请成功人数：0')
  const copy = [...harness.container.querySelectorAll('button')].find(button => button.textContent === '复制邀请码')!
  expect(copy.disabled).toBe(true)
})
it('requires explicit source confirmation and preserves the draft on a failed request', async () => {
  rpc.read.mockResolvedValue(summary()); rpc.claim.mockRejectedValue(new Error('offline'))
  await harness.render(createNode(ReferralClaimField,{ userId: 'new-user' }))
  const input = harness.container.querySelector('input')!
  await typeInto(input,'ABCDEF123456')
  expect(rpc.claim).not.toHaveBeenCalled()
  await clickElement([...harness.container.querySelectorAll('button')].find(button => button.textContent === '确认邀请来源')!)
  expect(rpc.claim).toHaveBeenCalledWith('new-user','ABCDEF123456')
  expect(input.value).toBe('ABCDEF123456')
  expect(harness.container.textContent).toContain('请重试')
  expect(harness.container.textContent).not.toContain('邀请来源已确认')
})

it('refreshes every visible source field for the account after confirmation', async () => {
  rpc.read.mockResolvedValue(summary())
  rpc.claim.mockImplementation(async () => {
    rpc.read.mockResolvedValue({ ...summary(), attribution: { code: 'ABCDEF123456', qualified: false, reward_state: 'pending' } })
    return 'attributed'
  })
  await harness.render(createNode('div',{},createNode(ReferralClaimField,{userId:'new-user'}),createNode(ReferralClaimField,{userId:'new-user'})))
  await typeInto(harness.container.querySelector('input')!,'ABCDEF123456')
  await clickElement([...harness.container.querySelectorAll('button')].find(button=>button.textContent==='确认邀请来源')!)
  expect(harness.container.querySelectorAll('input')).toHaveLength(0)
  expect([...harness.container.querySelectorAll('[role="status"]')].filter(p=>p.textContent?.includes('邀请来源已确认'))).toHaveLength(2)
})
