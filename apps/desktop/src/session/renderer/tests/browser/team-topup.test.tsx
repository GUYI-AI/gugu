import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { page, userEvent } from 'vitest/browser'
import { TeamProvider, TeamAccessGate } from '@/features/team/context'
import { TeamTopupDialog } from '@/features/team/TeamTopupDialog'
import { TeamPage } from '@/features/team/TeamPage'
import { TeamCheckoutError } from '../../../../../shared/team-topup'
import type { OpenTeamPayment } from '@/features/team/topup-checkout'
import { mockTeamApi, teamUser } from '../../../../../../../tests/fixtures/teamEdition'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/features/team/team.css'
const storageKey = 'gugu:team-topup:v1:team-person-lin:team-ming'
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await i18n.changeLanguage('zh-CN'); await page.viewport(1100, 850)
  document.documentElement.dataset.theme = 'light'; localStorage.removeItem(storageKey)
})
afterEach(() => harness?.cleanup())
async function mount(api: ReturnType<typeof mockTeamApi>, openPayment: OpenTeamPayment, settled = vi.fn(async () => undefined)) {
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamProvider user={teamUser} api={api}><TeamAccessGate>
    <TeamTopupDialog openPayment={openPayment} onClose={vi.fn()} onSettled={settled} />
  </TeamAccessGate></TeamProvider>, { auth: teamUser })
  await until('a real team recharge dialog loads', () => document.querySelector('[role=dialog]') !== null)
}
const click = (name: string) => act(async () => { await userEvent.click(page.getByRole('button', { name, exact: true })) })
it('applies a server coupon, opens one original intent and refreshes only after a paid order read', async () => {
  let status: 'pending' | 'paid' = 'pending'
  const base = mockTeamApi('admin'), topupQuote = vi.fn(base.topupQuote), settled = vi.fn(async () => undefined)
  const open = vi.fn<OpenTeamPayment>(async intent => ({ ok: true, order: { id: 'gtt-owned-ui', teamId: intent.teamId,
    credits: intent.quote.credits, amountCny: intent.quote.amountCny, status: 'pending' } }))
  await mount({ ...base, topupQuote, topupOrder: async (teamId, id) => ({ id, teamId, credits: 500, amountCny: '425.00', status }) }, open, settled)
  await until('the undiscounted coupon-free quote loads', () => /[¥￥]475/.test(document.body.textContent ?? ''))
  const count = topupQuote.mock.calls.length
  await act(async () => { await userEvent.fill(page.getByRole('textbox', { name: '优惠码' }), 'NEWTEAM') })
  expect(topupQuote.mock.calls.length).toBe(count)
  expect(page.getByRole('button', { name: '支付' }).element()).toBeDisabled()
  await click('使用')
  await until('the server returns 425 and a 50 deduction', () => /[¥￥]425/.test(document.body.textContent ?? '') && /优惠码 NEWTEAM/.test(document.body.textContent ?? ''))
  expect(document.body.textContent).toMatch(/已省.*75/)
  expect(topupQuote.mock.calls.at(-1)?.[0]).toMatchObject({ teamId: 'team-ming', credits: 500, couponCode: 'NEWTEAM' })
  const pay = page.getByRole('button', { name: /^支付.*425/ })
  await act(async () => { (pay.element() as HTMLButtonElement).click(); (pay.element() as HTMLButtonElement).click() })
  await until('the original order opens', () => open.mock.calls.length === 1 && document.body.textContent?.includes('订单尚未确认到账') === true)
  expect(settled).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({ orderId: 'gtt-owned-ui', quote: { couponCode: 'NEWTEAM', amountCny: '425.00' } })
  status = 'paid'
  await until('only an authorized paid order confirms the credit', () => document.body.textContent?.includes('充值已到账') === true)
  expect(settled).toHaveBeenCalledTimes(1); expect(localStorage.getItem(storageKey)).toBeNull()
  if (import.meta.env.VITE_TEAM_CAPTURE === '1') await page.screenshot({ path: '__screenshots__/team-topup-paid.png' })
})
it('recovers the same key, quote and payment method after response loss and quote expiry', async () => {
  const base = mockTeamApi('admin'), topupQuote = vi.fn(base.topupQuote)
  const open = vi.fn<OpenTeamPayment>().mockRejectedValueOnce(new TeamCheckoutError('dependency_unavailable'))
    .mockImplementation(async intent => ({ ok: true, order: { id: 'gtt-recovered-ui', teamId: intent.teamId,
      credits: intent.quote.credits, amountCny: intent.quote.amountCny, status: 'pending' } }))
  const api = { ...base, topupQuote, topupOrder: async (teamId: string, id: string) => ({ id, teamId, credits: 500, amountCny: '475.00', status: 'pending' as const }) }
  await mount(api, open)
  await until('the original quote is available', () => /[¥￥]475/.test(document.body.textContent ?? ''))
  await act(async () => { await userEvent.click(page.getByRole('button', { name: /^支付.*475/ })) })
  await until('the failed acknowledgment retains recovery', () => document.body.textContent?.includes('继续原订单支付') === true)
  const original = JSON.parse(localStorage.getItem(storageKey)!)
  original.quote.expiresAt = Date.now() - 1; localStorage.setItem(storageKey, JSON.stringify(original))
  const quoteCalls = topupQuote.mock.calls.length
  harness.cleanup(); await mount(api, open)
  await until('the expired original intent is restored', () => document.body.textContent?.includes('继续原订单支付') === true)
  expect(topupQuote.mock.calls.length).toBe(quoteCalls)
  await click('继续原订单支付')
  await until('the original order is read after retry', () => JSON.parse(localStorage.getItem(storageKey)!).orderId === 'gtt-recovered-ui')
  expect(open.mock.calls[1][0]).toEqual(original)
  expect(open.mock.calls[1][0].key).toBe(open.mock.calls[0][0].key)
  expect(document.body.textContent).not.toContain('充值已到账')
})
it('does not offer recharge to an ordinary member', async () => {
  const api = mockTeamApi('member'), topupQuote = vi.fn(api.topupQuote)
  harness = createReactHarness()
  await renderWithAppProviders(harness, <TeamProvider user={teamUser} api={{ ...api, topupQuote }}><TeamAccessGate><TeamPage /></TeamAccessGate></TeamProvider>, { auth: teamUser })
  await until('the ordinary team page loads', () => harness.container.querySelectorAll('.gg-team-settings-member').length > 0)
  expect(harness.container.textContent).not.toContain('充值'); expect(topupQuote).not.toHaveBeenCalled()
})
