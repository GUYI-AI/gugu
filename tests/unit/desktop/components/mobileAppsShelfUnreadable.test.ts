// @vitest-environment jsdom
// The phone's market after a restart: its first screen kept, the shelf unreadable — said with a retry, ❌ the first screen
// (or the skeleton) forever.
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const manifest = vi.hoisted(() => ({ id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 35, defaultLocale: 'en', permissions: { capabilities: [] }, contributes: { tabs: [] } }))
const market = vi.hoisted(() => ({ entries: [{ manifest, cloud: {}, ref: { extensionId: 'notes', version: '1.0.0' } }], featured: [], fails: true }))

vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({
  PHONE_CAPABILITIES: [],
  phoneApps: {
    ready: async () => {}, reload: async () => {}, unreadable: () => null,
    market: { onRefreshed: () => () => {}, refresh: async () => ({ outcome: 'unchanged' }) },
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions', () => ({
  installedExtensions: { refresh: async () => {} },
  useInstalledApps: () => ({ state: 'value', stale: false, error: null, value: { manifests: [manifest], unreadable: null, isEnabled: () => true, isPreinstalled: () => false, mainTabOf: () => null } }),
}))
vi.mock('../../../../apps/desktop/src/components/settings/phoneMarketPage', () => ({
  PHONE_HOST: 'phone',
  phoneProductApi: {},
  phoneSearchRows: (items: unknown[]) => items,
  useOfferedVersions: () => ({ state: 'value', stale: false, error: null, value: { offered: {}, gone: [] } }),
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
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/panel/app-market-content', () => ({ AppMarketContent: () => createElement('div', { 'data-testid': 'shelf' }), AppMarketFirstScreen: () => createElement('div', { 'data-testid': 'first-screen' }) }))
// The phone's shelf as read: the one App, as the market lists it.
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/market-replicas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/features/extensions/market-replicas')>()
  actual.definePhoneMarket({
    shelf: async () => { if (market.fails) throw new Error('index unreadable'); return { errorKind: null, items: market.entries as never, invalid: [], total: 1, page: 0, hasMore: false, featured: [], home: { remaining: [], newest: [], popular: [] }, rankingError: null, fetchedAt: null } },
    marketListing: async () => ({ success: false, error: 'none' }), marketHistory: async () => ({ success: true, data: [] }), onRefreshed: () => () => {},
  })
  return actual
})

const { MobileAppsSection } = await import('../../../../apps/desktop/src/components/settings/MobileAppsSection')
const { marketShelf } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/market-replicas')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

const find = (selector: string) => harness.container.ownerDocument.querySelector<HTMLElement>(selector)

it('a kept first screen and the shelf unreadable: the failure is said with a retry, and the retry reads it', async () => {
  const first = { featured: [], featuredCount: 0, grid: [], remainingCount: 0, categories: [] }
  for (const locale of ['en-US', 'zh-CN']) marketShelf.set(['phone', locale], { first })
  await harness.render(createElement(MobileAppsSection))
  await vi.waitFor(() => expect(find('[data-testid="phone-app-market"] [role="alert"]')).not.toBeNull())
  expect(find('[data-testid="first-screen"]')).not.toBeNull()
  market.fails = false
  await act(async () => { find('[data-testid="phone-app-market"] [role="alert"] button')!.click() })
  await vi.waitFor(() => expect(find('[data-testid="shelf"]')).not.toBeNull())
  expect(find('[data-testid="phone-app-market"] [role="alert"]')).toBeNull()
})
