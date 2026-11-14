import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GuguSubscriptionRow } from '@/session/renderer/features/settings/subscriptions/GuguSubscriptionRow'
import { ModelMenuFooter } from '@/mobile/agent-watch/ModelMenuFooter'

const data = vi.hoisted(() => ({
  native: true, platform: 'ios', error: '',
  power: { spendable: 4.997506, walletCredits: 4.997506, held: 0 },
  openSettings: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({ Capacitor: {
  isNativePlatform: () => data.native, getPlatform: () => data.platform,
} }))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'account' } }) }))
vi.mock('@/platform', () => ({ platform: {} }))
vi.mock('@/lib/billing', () => ({
  useSpendingPower: () => ({ power: data.error ? null : data.power, windows: null,
    balanceError: data.error || null, windowsError: null,
    membership: { tier: 'free', expiresAt: new Date('2026-11-10T00:00:00Z') } }),
  quotaWindowViews: () => { throw new Error('No quota response supplied') },
  formatCredits: (value: number) => String(value),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ locale: 'en-US', translate: (key: string, values?: Record<string, string>) =>
    key + (values ? ' ' + Object.values(values).join(' ') : '') }),
}))
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }))
vi.mock('@renderer/lib/open-shell-settings', () => ({ openShellSettings: data.openSettings }))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks(); data.native = true; data.platform = 'ios'; data.error = ''
  container = document.createElement('div'); document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
async function render(node: ReturnType<typeof createElement>) { await act(async () => root.render(node)) }

describe('native iOS account display', () => {
  it('keeps the actual balance, membership and expiry while omitting purchase links', async () => {
    await render(createElement(GuguSubscriptionRow))
    expect(container.querySelector('[data-testid="subscription-credits-balance"]')?.textContent).toBe('4.997506')
    expect(container.textContent).toContain('Free')
    expect(container.textContent).toContain('Nov 10, 2026')
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.textContent).not.toContain('subscriptions.gugu.manage')
    expect(container.textContent).not.toContain('usage.na.openWebBilling')
  })
  it('preserves account read errors without inventing a zero balance', async () => {
    data.error = 'account_unavailable'
    await render(createElement(GuguSubscriptionRow))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('account_unavailable')
    expect(container.querySelector('[data-testid="subscription-credits-balance"]')?.textContent).toBe('—')
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
  it.each(['android', 'web'])('retains the existing account destinations on %s', async platform => {
    data.platform = platform; data.native = platform !== 'web'
    await render(createElement(GuguSubscriptionRow))
    const links = Array.from(container.querySelectorAll('a'))
    expect(links).toHaveLength(2)
    expect(links.map(link => link.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('subscriptions.gugu.manage'), expect.stringContaining('usage.na.openWebBilling'),
    ]))
    expect(links.every(link => link.href.startsWith('https://'))).toBe(true)
  })
  it('keeps model management usable without an upgrade action or marketing list', async () => {
    const leave = vi.fn()
    await render(createElement(ModelMenuFooter, { lockedModels: ['V4 Pro'], onLeave: leave }))
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map(button => button.textContent)).toEqual(['composer.manageModels'])
    expect(container.textContent).not.toContain('V4 Pro')
    await act(async () => buttons[0]!.click())
    expect(leave).toHaveBeenCalledTimes(1)
    expect(data.openSettings).toHaveBeenCalledExactlyOnceWith('model')
  })
  it('retains model upgrade controls outside the iOS package', async () => {
    data.native = false; data.platform = 'web'
    await render(createElement(ModelMenuFooter, { lockedModels: ['V4 Pro'], onLeave: vi.fn() }))
    expect(Array.from(container.querySelectorAll('button')).map(button => button.textContent))
      .toEqual(['composer.manageModels', 'composer.platformModelUpgrade'])
  })
})
