// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createNode, createReactHarness, renderWithAppProviders, typeInto, clickElement } from '../../../support/testHarness'
import { i18n, setLocalePreference } from '../../../../apps/desktop/src/i18n'
import '../../../../apps/desktop/src/i18n/registerMainCatalog'
const rpc = vi.hoisted(() => ({ read: vi.fn(), claim: vi.fn(), activity: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/referrals', () => ({ getMyReferral: rpc.read, claimMyReferral: rpc.claim, getMyReferralActivity: rpc.activity }))
import { InvitationPanel } from '../../../../apps/desktop/src/components/referralPreview/InvitationPanel'
import { viewStateCache } from '../../../../apps/desktop/src/session/renderer/lib/stores/view-state-cache'
import { ReferralClaimField } from '../../../../apps/desktop/src/components/referralPreview/ReferralClaimField'

let harness: ReturnType<typeof createReactHarness>
const summary = () => ({ status: 'ok', code: 'ABCDEF123456', code_enabled: true, successful_invitations: 3,
  rewarded_invitations: 1, earned_cny: '2.75', claim_available: true, claim_deadline: '2026-12-01', attribution: null,
  policy: { rewards_enabled: false, credits_each_cny: '2.75', recipients: 'invitee', success_condition: 'first_message', max_rewards_per_inviter: null } })
beforeEach(async () => {
  harness = createReactHarness(); localStorage.clear(); viewStateCache.forget('view:'); rpc.read.mockReset(); rpc.claim.mockReset(); rpc.activity.mockResolvedValue({ status: 'ok', items: [], next_cursor: null })
  setLocalePreference('zh-CN'); await i18n.changeLanguage('zh-CN')
})
afterEach(() => { harness.cleanup() })

it('shows real success and actually received credits even when rewards are disabled', async () => {
  rpc.read.mockResolvedValue(summary())
  await renderWithAppProviders(harness,createNode(InvitationPanel))
  expect(harness.container.querySelector('.gg-referral-stats')?.textContent).toContain('3 人')
  expect(harness.container.querySelector('.gg-referral-stats')?.textContent).toContain('2.75 积分')
  expect(harness.container.textContent).not.toContain('各 5')
})
it('shows an unavailable state without a fabricated zero count or enabled share buttons', async () => {
  rpc.read.mockRejectedValue(new Error('offline'))
  await renderWithAppProviders(harness,createNode(InvitationPanel))
  expect(harness.container.textContent).toContain('无法读取邀请信息')
  expect(harness.container.querySelector('.gg-referral-stats')?.textContent).toBe('—已邀请—已到账')
  const copy = [...harness.container.querySelectorAll('button')].find(button => button.textContent === '复制邀请码')!
  expect(copy.disabled).toBe(true)
})
it('requires explicit source confirmation and preserves the draft on a failed request', async () => {
  rpc.read.mockResolvedValue(summary()); rpc.claim.mockRejectedValue(new Error('offline'))
  await renderWithAppProviders(harness, createNode(ReferralClaimField,{ userId: 'new-user' }), { auth: { id: 'new-user' } })
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
  await renderWithAppProviders(harness, createNode('div',{},createNode(ReferralClaimField,{userId:'new-user'}),createNode(ReferralClaimField,{userId:'new-user'})), { auth: { id: 'new-user' } })
  await typeInto(harness.container.querySelector('input')!,'ABCDEF123456')
  await clickElement([...harness.container.querySelectorAll('button')].find(button=>button.textContent==='确认邀请来源')!)
  expect(harness.container.querySelectorAll('input')).toHaveLength(0)
  expect([...harness.container.querySelectorAll('[role="status"]')].filter(p=>p.textContent?.includes('邀请来源已确认'))).toHaveLength(2)
})

it('keeps an unconfirmed source draft through remounts and isolates it from another account', async () => {
  rpc.read.mockResolvedValue(summary())
  await renderWithAppProviders(harness, createNode(ReferralClaimField, { userId: 'draft-owner', key: 'draft-owner' }), { auth: { id: 'draft-owner' } })
  await typeInto(harness.container.querySelector('input')!, 'ABCDEF123456')
  await harness.render(null)
  await renderWithAppProviders(harness, createNode(ReferralClaimField, { userId: 'draft-owner', key: 'draft-owner' }), { auth: { id: 'draft-owner' } })
  expect(harness.container.querySelector('input')!.value).toBe('ABCDEF123456')
  await renderWithAppProviders(harness, createNode(ReferralClaimField, { userId: 'other-owner', key: 'other-owner' }), { auth: { id: 'other-owner' } })
  expect(harness.container.querySelector('input')!.value).toBe('')
  expect(rpc.claim).not.toHaveBeenCalled()
})

it('loads genuine paginated activity and preserves historical credited values', async () => {
  rpc.read.mockResolvedValue(summary())
  const row = { key: 'one', display_name: '受邀朋友甲', avatar: null, invited_at: '2026-11-18T12:00:00Z', state: 'credited', credited: true, credited_cny: '1.25000000' }
  rpc.activity.mockResolvedValueOnce({ status: 'ok', items: [row], next_cursor: 'next' })
    .mockResolvedValueOnce({ status: 'ok', items: [{ ...row, key: 'two', display_name: '受邀朋友乙', state: 'awaiting_message', credited: false, credited_cny: '0' }], next_cursor: null })
  await renderWithAppProviders(harness, createNode(InvitationPanel))
  const list = harness.container.querySelector('[data-testid="referral-activity"]')!
  expect(list.textContent).toContain('受邀朋友甲')
  expect(list.textContent).toContain('+1.25')
  await clickElement([...list.querySelectorAll('button')].find(button => button.textContent === '加载更多')!)
  expect(list.textContent).toContain('受邀朋友甲')
  expect(list.textContent).toContain('受邀朋友乙')
  expect(list.textContent).toContain('尚未发送消息')
  expect(list.textContent).not.toContain('加载更多')
  expect(rpc.activity.mock.calls.at(-1)?.[1]).toBe('next')
})
it('keeps an activity failure distinct from a genuinely empty history', async () => {
  rpc.read.mockResolvedValue(summary())
  rpc.activity.mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ status: 'ok', items: [], next_cursor: null })
  await renderWithAppProviders(harness, createNode(InvitationPanel))
  const list = harness.container.querySelector('[data-testid="referral-activity"]')!
  expect(list.textContent).toContain('无法读取邀请记录')
  expect(list.textContent).not.toContain('暂无邀请记录')
  await clickElement(list.querySelector('button')!)
  expect(list.textContent).toContain('暂无邀请记录')
})

it('shares one account reading across source fields and keeps another account isolated from late activity', async () => {
  rpc.read.mockResolvedValue(summary())
  let finishOld!: (value: unknown) => void
  rpc.activity.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    .mockResolvedValue({ status: 'ok', items: [], next_cursor: null })
  await renderWithAppProviders(harness, createNode('div', {}, createNode(ReferralClaimField, { userId: 'first' }), createNode(ReferralClaimField, { userId: 'first' })), { auth: { id: 'first' } })
  expect(rpc.read).toHaveBeenCalledTimes(1)
  await renderWithAppProviders(harness, createNode(InvitationPanel), { auth: { id: 'first' } })
  await renderWithAppProviders(harness, createNode(InvitationPanel), { auth: { id: 'second' } })
  await act(async () => { finishOld({ status: 'ok', items: [{ key: 'old', display_name: '前一个账号的朋友', avatar: null, invited_at: '2026-11-18T12:00:00Z', state: 'credited', credited: true, credited_cny: '1' }], next_cursor: null }) })
  expect(harness.container.textContent).not.toContain('前一个账号的朋友')
  expect(harness.container.textContent).toContain('暂无邀请记录')
  expect(rpc.activity.mock.calls.at(-1)?.[0]).toBe('second')
})
