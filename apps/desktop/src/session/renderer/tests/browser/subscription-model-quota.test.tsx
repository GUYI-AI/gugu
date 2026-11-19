import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/replica'
import { setLocalePreference } from '@/i18n'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { subscriptionUsage } from '@renderer/features/settings/subscriptions/subscription-queries'
import { SubscriptionModelQuota } from '@/components/settings/SubscriptionModelQuota'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

const control = vi.hoisted(() => ({ fiveHours: true, unavailable: false, reads: [] as string[] }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    readSubscriptionUsage: async ({ connectionId }: { connectionId: string }) => {
      control.reads.push(connectionId)
      return { success: true, data: control.unavailable
        ? { kind: 'unavailable', reason: 'not-signed-in', readAt: 1_790_000_000_000 }
        : { kind: 'windows', readAt: 1_790_000_000_000, windows: [
          ...(control.fiveHours ? [{ windowMinutes: 300, usedPercent: 20, resetsAt: 1_790_003_600_000 }] : []),
          { windowMinutes: 10_080, usedPercent: 40, resetsAt: 1_790_086_400_000 },
        ] } }
    },
  }),
}))

let host: HTMLDivElement
let root: Root
beforeEach(async () => {
  queryClient.clear()
  Object.assign(control, { fiveHours: true, unavailable: false, reads: [] })
  await setLocalePreference('zh-CN')
  document.documentElement.dataset.theme = 'light'
  host = document.createElement('div')
  host.style.cssText = 'padding:80px;width:700px'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => { root.unmount(); host.remove(); queryClient.clear(); delete document.documentElement.dataset.theme })
function render(enabled = true, provider: 'claude' | 'codex' = 'claude') {
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <div data-quota-mounted><SubscriptionModelQuota machine={null} provider={provider} connectionId="saved-account" account="Test account" enabled={enabled} /></div>
  </SessionLocalizationProvider></QueryClientProvider>)
}

it('shows real independent windows and their original update/reset times on hover', async () => {
  render()
  await until('both real quota windows are shown', () => host.querySelectorAll('[role="meter"]').length === 2)
  expect(host.textContent).toContain('剩余 80%')
  expect(host.textContent).toContain('剩余 60%')
  expect(control.reads).toEqual(['saved-account'])
  await userEvent.hover(page.getByTestId('model-quota-saved-account'))
  await until('the quota tooltip exposes both reset times', () => document.querySelector('[role="tooltip"]')?.textContent?.match(/重置/g)?.length === 2)
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('更新')
})

it('omits only the missing five-hour window instead of drawing a sample limit', async () => {
  control.fiveHours = false
  render()
  await until('the available weekly window is shown', () => host.querySelectorAll('[role="meter"]').length === 1)
  expect(host.textContent).not.toContain('5 小时')
  expect(host.textContent).toContain('每周')
  expect(host.textContent).not.toContain('剩余 0%')
})

it('does not draw quotas for an unavailable reading', async () => {
  control.unavailable = true
  render()
  await until('the unavailable account reading is committed', () => subscriptionUsage.peek(null, 'claude', 'saved-account').state === 'value')
  expect(host.querySelector('[role="meter"]')).toBeNull()
  expect(host.querySelector('[data-testid^="model-quota"]')).toBeNull()
})

it('does not request or show quotas for a disabled sign-in', async () => {
  render(false)
  await until('the disabled component has mounted', () => host.querySelector('[data-quota-mounted]') !== null)
  expect(control.reads).toEqual([])
  expect(host.querySelector('[role="meter"]')).toBeNull()
})

it('observes the shared usage cache without issuing a second reading', async () => {
  render()
  await until('the first reading reaches the settings row', () => host.textContent?.includes('剩余 60%') === true)
  subscriptionUsage.at(null, 'claude', 'saved-account').set({ kind: 'windows', readAt: 1_790_000_000_000, windows: [{ windowMinutes: 10_080, usedPercent: 75 }] })
  await until('a reading from the shared cache updates the same row', () => host.textContent?.includes('剩余 25%') === true)
  expect(control.reads).toEqual(['saved-account'])
})

it('uses the shared silver palette with theme-specific visible boundaries', async () => {
  render(true, 'codex')
  await until('the silver quota bar is visible', () => host.querySelector('.gg-model-quota-track > span') !== null)
  const bar = host.querySelector('.gg-model-quota-track > span')!
  expect(getComputedStyle(bar).getPropertyValue('--quota-fill')).toBe(getComputedStyle(document.documentElement).getPropertyValue('--usage-brand-codex-fill').trim())
  expect(getComputedStyle(bar).getPropertyValue('--quota-edge')).toBe(getComputedStyle(document.documentElement).getPropertyValue('--usage-brand-codex-edgeLight').trim())
  document.documentElement.dataset.theme = 'dark'
  expect(getComputedStyle(bar).getPropertyValue('--quota-edge')).toBe(getComputedStyle(document.documentElement).getPropertyValue('--usage-brand-codex-edgeDark').trim())
})
