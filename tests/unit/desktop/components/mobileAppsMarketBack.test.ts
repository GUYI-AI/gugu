// @vitest-environment jsdom
// An App's market page opened from its settings page on the phone: back returns to the settings page, as on the desktop.
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const manifest = vi.hoisted(() => ({ id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 35, defaultLocale: 'en', permissions: { capabilities: [] }, contributes: { tabs: [] } }))
const market = vi.hoisted(() => ({ entries: [{ manifest, cloud: {}, ref: { extensionId: 'notes', version: '1.0.0' } }], featured: [] }))

vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({
  PHONE_CAPABILITIES: [],
  phoneApps: {
    ready: async () => {}, reload: async () => {}, unreadable: () => null,
    market: { onRefreshed: () => () => {}, refresh: async () => ({ outcome: 'unchanged' }) },
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { manifests: [manifest], isEnabled: () => true, isPreinstalled: () => false, mainTabOf: () => null },
}))
vi.mock('../../../../apps/desktop/src/components/settings/phoneMarketPage', () => ({
  PHONE_HOST: 'phone',
  keptPhoneMarketPage: market,
  phoneProductApi: {},
  readPhoneMarketPage: async () => market,
  phoneMarketRows: (entries: unknown[]) => entries,
  useOfferedVersions: () => ({ updates: {}, gone: [] }),
}))
vi.mock('../../../../apps/desktop/src/components/settings/AppsSection', () => ({
  AppsSection: ({ onManage }: { onManage: (id: string) => void }) => createElement('button', { 'data-testid': 'row', onClick: () => onManage('notes') }),
}))
vi.mock('../../../../apps/desktop/src/components/settings/PhoneAppManage', () => ({
  PhoneAppManage: ({ onViewInMarket }: { onViewInMarket: () => void }) => createElement('button', { 'data-testid': 'manage', onClick: onViewInMarket }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-product-page', () => ({
  AppProductPage: ({ onBack, backLabel }: { onBack: () => void; backLabel?: string }) => createElement('button', { 'data-testid': 'product', onClick: onBack }, backLabel ?? 'market'),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-market-content', () => ({ AppMarketContent: () => null }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-featured', () => ({ featuredShotsReady: async () => {} }))

const { MobileAppsSection } = await import('../../../../apps/desktop/src/components/settings/MobileAppsSection')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

const find = (id: string) => harness.container.ownerDocument.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = async (id: string) => { await act(async () => { find(id)!.click() }) }

it('back from the market page returns to the settings page it was opened from', async () => {
  await harness.render(createElement(MobileAppsSection))
  await click('phone-apps-installed-tab')
  await click('row')
  await click('manage')
  expect(find('manage')).toBeNull()
  expect(find('product')?.textContent).not.toBe('market')
  await click('product')
  expect(find('product')).toBeNull()
  expect(find('manage')).not.toBeNull()
})
