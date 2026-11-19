import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { QueryClientProvider } from '@tanstack/react-query'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { SidebarUsage } from '@/components/usage/SidebarUsage'
import { queryClient } from '@/lib/replica'
import { setLocalePreference } from '@/i18n'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/i18n/registerMainCatalog'
import { UI_EVENTS } from '@/lib/uiEvents'
import { subscriptionUsage } from '@renderer/features/settings/subscriptions/subscription-queries'
import '@/styles/tokens.css'
import '@/components/Sidebar.css'
import '@renderer/index.css'

const control = vi.hoisted(() => ({
  missingFiveHours: false, expired: false, apiKey: false, refreshFails: false,
  reads: [] as { providerId: string; connectionId: string; force: boolean }[],
  creditRefreshes: 0,
}))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'usage-test-user' } }) }))
vi.mock('@/lib/billing', () => ({
  useSpendingPower: () => ({ state: 'value', balance: '2345.67' }),
  refreshSpendingPower: async () => { control.creditRefreshes++ },
  formatCredits: (value: string) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }),
}))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    listConnections: async ({ providerId }: { providerId: string }) => ({ success: true, data: [{ id: `${providerId}-one`, kind: 'account', name: `${providerId}-account`, current: true }] }),
    refreshAuthStatus: async () => ({ success: true, data: control.expired
      ? { kind: 'unauthenticated', reason: 'expired' }
      : { kind: 'authenticated', credentialKind: control.apiKey ? 'api-key' : 'subscription' } }),
    readSubscription: async () => ({ success: true, data: { payer: control.apiKey ? 'api-key' : 'subscription' } }),
    readSubscriptionUsage: async (input: { providerId: string; connectionId: string; force: boolean }) => {
      control.reads.push(input)
      if (input.force && control.refreshFails) return { success: false, error: { message: 'Vendor unavailable' } }
      return { success: true, data: { kind: 'windows', readAt: 1_790_000_000_000, windows: [
        ...(control.missingFiveHours ? [] : [{ windowMinutes: 300, usedPercent: 25, resetsAt: 1_790_003_600_000 }]),
        { windowMinutes: 10_080, usedPercent: input.providerId === 'claude' ? 30 : 90, resetsAt: 1_790_086_400_000 },
      ] } }
    },
  }),
}))

let element: HTMLDivElement
let root: Root
beforeEach(async () => {
  queryClient.clear()
  Object.assign(control, { missingFiveHours: false, expired: false, apiKey: false, refreshFails: false, reads: [], creditRefreshes: 0 })
  await setLocalePreference('zh-CN')
  document.documentElement.dataset.theme = 'light'
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => { root.unmount(); element.remove(); queryClient.clear(); delete document.documentElement.dataset.theme })
async function open() {
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><SidebarUsage /></SessionLocalizationProvider></QueryClientProvider>)
  await userEvent.click(page.getByTestId('sidebar-usage'))
  await until('the nearby usage popup is open', () => document.querySelector('[data-testid="usage-popover"]') !== null)
}

it('shows per-account real windows, matching ring/bar colors, and the shared credit balance', async () => {
  const capture = import.meta.env.VITE_USAGE_CAPTURE === '1'
  if (capture) {
    await page.viewport(540, 740)
    element.style.cssText = 'position:absolute;left:0;bottom:60px;width:40px;height:40px'
  }
  await open()
  await until('both account windows render', () => document.querySelectorAll('[role="meter"]').length === 4)
  expect(document.body.textContent).toContain('剩余 70%')
  expect(document.body.textContent).toContain('剩余 10%')
  expect(document.body.textContent).toContain('2,345.67')
  expect(control.reads.map(read => read.connectionId).sort()).toEqual(['claude-one', 'codex-one'])
  expect(document.querySelectorAll('.gg-usage-ring')).toHaveLength(2)
  for (const [index, provider] of ['claude', 'codex'].entries()) {
    const ring = document.querySelectorAll('.gg-usage-ring')[index]!
    const section = document.querySelector(`[data-provider="${provider}"]`)!
    expect(getComputedStyle(ring).getPropertyValue('--usage-fill')).toBe(getComputedStyle(section).getPropertyValue('--usage-fill'))
  }
  const silver = document.querySelector('[data-provider="codex"] .gg-usage-track > span')!
  expect(getComputedStyle(silver).backgroundColor).toBe('rgb(230, 232, 236)')
  if (capture) {
    const label = document.createElement('p')
    label.textContent = '组件测试夹具，非真实账号'
    label.style.cssText = 'position:fixed;left:16px;top:16px;color:var(--muted-fg)'
    element.append(label)
    await page.screenshot({ path: '__screenshots__/sidebar-usage/light.png' })
  }
  document.documentElement.dataset.theme = 'dark'
  expect(getComputedStyle(silver).getPropertyValue('--usage-edge').trim()).toBe(getComputedStyle(document.documentElement).getPropertyValue('--usage-brand-codex-edgeDark').trim())
  if (capture) await page.screenshot({ path: '__screenshots__/sidebar-usage/dark.png' })
})

it('keeps a missing five-hour row explicit while weekly readings and rings remain usable', async () => {
  control.missingFiveHours = true
  await open()
  await until('weekly readings render without five-hour values', () => document.querySelectorAll('[role="meter"]').length === 2)
  expect(document.querySelectorAll('.gg-usage-ring')).toHaveLength(2)
  expect(document.body.textContent?.match(/官方未返回可用窗口/g)).toHaveLength(2)
  expect(document.body.textContent).not.toContain('剩余 0%')
})

it('does not turn expired subscriptions or API-key connections into quota rings', async () => {
  control.expired = true
  await open()
  await until('expired sign-in is reported', () => document.body.textContent?.includes('登录已失效') === true)
  expect(control.reads).toHaveLength(0)
  expect(document.querySelectorAll('.gg-usage-ring')).toHaveLength(0)
  expect(document.querySelectorAll('[role="meter"]')).toHaveLength(0)
})

it('omits API-key accounts instead of labeling their usage as subscription limits', async () => {
  control.apiKey = true
  await open()
  await until('account reads finish without API quota rows', () => document.querySelectorAll('[aria-busy="true"]').length === 0)
  expect(control.reads).toHaveLength(0)
  expect(document.querySelectorAll('[data-provider]')).toHaveLength(0)
})

it('forces refresh for each original account and preserves the last successful timestamp on failure', async () => {
  await open()
  await until('both account windows render before refreshing', () => document.querySelectorAll('[role="meter"]').length === 4)
  control.refreshFails = true
  await userEvent.click(page.getByRole('button', { name: '刷新用量' }))
  await until('failed refresh keeps its previous reading', () => document.body.textContent?.includes('刷新失败，显示上次读数。') === true)
  const forced = control.reads.filter(read => read.force)
  expect(forced.map(read => read.connectionId).sort()).toEqual(['claude-one', 'codex-one'])
  expect(control.creditRefreshes).toBe(1)
  const reading = subscriptionUsage.peek(null, 'claude', 'claude-one')
  expect(reading.state === 'value' && reading.value.readAt).toBe(1_790_000_000_000)
  expect(document.body.textContent).toContain('剩余 70%')
})

it('opens the existing full-usage page and supports Escape dismissal', async () => {
  const settings = vi.fn()
  window.addEventListener(UI_EVENTS.openSettings, settings)
  try {
    await open()
    await userEvent.click(page.getByRole('button', { name: '查看完整用量' }))
    expect(settings).toHaveBeenCalledTimes(1)
    expect((settings.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: 'usage' })
    await userEvent.click(page.getByTestId('sidebar-usage'))
    await userEvent.keyboard('{Escape}')
    await until('Escape dismisses the usage popup', () => document.querySelector('[data-testid="usage-popover"]') === null)
  } finally { window.removeEventListener(UI_EVENTS.openSettings, settings) }
})
