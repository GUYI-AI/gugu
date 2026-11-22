// @vitest-environment jsdom
import { Component, act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { creditDecimal } from '@gugu/core/billing/creditAmount'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { GuguSubscriptionRow } from '../../../../apps/desktop/src/session/renderer/features/settings/subscriptions/GuguSubscriptionRow'
import { isMember, membershipFailure, refreshSpendingPower, useSpendingPower } from '../../../../apps/desktop/src/lib/billing/useSpendingPower'
import { readCreditV2Account } from '../../../../apps/desktop/src/lib/billing/v2/runtime'

// Keep the shared replica, membership projection and row real; substitute only I/O.
vi.mock('../../../../apps/desktop/src/lib/billing/v2/runtime', () => ({ readCreditV2Account: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(() => ({})), unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', async original => {
  const module = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...module, platform: { ...module.platform, readDeviceFreeCreditsStatus: async () => 'device_full' } }
})
function account(tierKey: string): Awaited<ReturnType<typeof readCreditV2Account>> {
  const d = creditDecimal
  return {
    balance: d('7.5'), balanceError: null, windowsError: null,
    plan: { planId: 'paid-plan', tierKey, monthlyPriceCny: d('100'), periodCredits: d('7.5'), balanceCredits: d('7.5'), topupCreditsPerCny: d('1'), periodHours: 720, expiresAt: null },
    windows: { plan_id: 'paid-plan', period_credits: d('7.5'), period_used: d('0'), outstanding_credits: d('0'), credits_per_usd: null,
      period_started_at: '2026-11-01T00:00:00Z', period_ends_at: '2026-12-01T00:00:00Z' },
    meta: { credit_unit_version: 2, active_credit_unit_version: 2, gateway_price_version: 2, gateway_currency: 'CNY', fx_cny_per_usd: d('6.718'),
      fx_source_url: 'https://example.test/rate', fx_asof_date: '2026-11-04', fx_published_at_utc: '2026-11-04T07:00:00Z' },
  }
}
class ShellBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <p data-testid="shell-error">Shell failed</p> : this.props.children }
}
function Screen() {
  const spending = useSpendingPower({ id: 'u1' })
  const [clicks, setClicks] = useState(0)
  return <><button data-testid="navigation" onClick={() => setClicks(n => n + 1)}>Messages {clicks}</button>
    <main data-testid="conversation">Conversation remains available</main>
    <GuguSubscriptionRow />
    <pre>{JSON.stringify({ spending, member: isMember(spending), failure: membershipFailure(spending) })}</pre></>
}
let harness: ReturnType<typeof createReactHarness>
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })
const snapshot = () => JSON.parse(harness.container.querySelector('pre')!.textContent!)
async function render(tier: string) {
  vi.mocked(readCreditV2Account).mockResolvedValue(account(tier))
  await renderWithAppProviders(harness, <ShellBoundary><Screen /></ShellBoundary>, { auth: { id: 'u1', email: 'u@example.test', nickname: 'U' } })
  await flush()
}
beforeEach(() => { vi.clearAllMocks(); harness = createReactHarness() })
afterEach(() => harness.cleanup())

it('contains an unknown paid tier to membership while navigation, conversation and verified credits remain usable', async () => {
  await render('future-paid')
  expect(harness.container.querySelector('[data-testid="shell-error"]')).toBeNull()
  const row = harness.container.querySelector('[data-testid="subscription-row-gugu"]')!
  expect(row.textContent).toContain('无法读取会员信息')
  expect(row.querySelector('.subscription-plan-badge')).toBeNull()
  expect(row.textContent).not.toMatch(/Free|future-paid/)
  expect(row.querySelector('[data-testid="subscription-credits-balance"]')?.textContent).toBe('15')
  expect(snapshot()).toMatchObject({ member: null, failure: '无法读取会员信息，请更新应用后重试', spending: {
    state: 'value', membership: null, membershipError: '无法读取会员信息，请更新应用后重试', balance: '7.5', balanceError: null, windowsError: null,
    power: { spendable: '15' },
  } })
  await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-testid="navigation"]')!.click())
  expect(harness.container.querySelector('[data-testid="navigation"]')?.textContent).toBe('Messages 1')
  expect(harness.container.querySelector('[data-testid="conversation"]')?.textContent).toBe('Conversation remains available')
})

it('drops an obsolete paid badge on an unknown tier and recovers membership after a recognized refresh', async () => {
  await render('pro')
  expect(snapshot().member).toBe(true)
  expect(harness.container.querySelector('.subscription-plan-badge')?.textContent).toBe('Pro')
  vi.mocked(readCreditV2Account).mockResolvedValue(account('future-paid'))
  await act(async () => { await refreshSpendingPower() }); await flush()
  expect(snapshot().member).toBeNull()
  expect(harness.container.querySelector('.subscription-plan-badge')).toBeNull()
  vi.mocked(readCreditV2Account).mockResolvedValue(account('free'))
  await act(async () => { await refreshSpendingPower() }); await flush()
  expect(snapshot()).toMatchObject({ member: false, failure: null, spending: { membershipError: null, membership: { tier: 'free' } } })
  expect(harness.container.querySelector('.subscription-plan-badge')?.textContent).toBe('Free')
  expect(harness.container.querySelector('[data-testid="shell-error"]')).toBeNull()
})
