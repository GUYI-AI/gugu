// @vitest-environment jsdom
// The phone's Apps page: what is installed, read before and its read again failing, is said with a retry over the rows kept.
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const manifest = vi.hoisted(() => ({ id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 35, defaultLocale: 'en', permissions: { capabilities: [] }, contributes: { tabs: [] } }))
const market = vi.hoisted(() => ({ entries: [{ manifest, cloud: {}, ref: { extensionId: 'notes', version: '1.0.0' } }], fails: true, installedError: null as Error | null }))

vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({
  PHONE_CAPABILITIES: [],
  phoneApps: {
    ready: async () => {}, reload: async () => {}, unreadable: () => null,
    market: { onRefreshed: () => () => {}, refresh: async () => ({ outcome: 'unchanged' }) },
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions')>(),
  useInstalledApps: () => ({ state: 'value', stale: false, error: market.installedError, value: { manifests: [manifest], unreadable: null, isEnabled: () => true, isPreinstalled: () => false, mainTabOf: () => null } }),
}))
// The catalog's reading, as the page reads it (`useReplica(phoneMarketCatalog, …)`).
vi.mock('../../../../apps/desktop/src/lib/replica', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/lib/replica')>()
  const useReplica = ((model, ...rest) => model === ('catalog' as never) ? { state: 'value', stale: false, error: null, value: { entries: [] } } : actual.useReplica(model, ...rest)) as typeof actual.useReplica
  return { ...actual, useReplica }
})
vi.mock('../../../../apps/desktop/src/components/settings/phoneMarketPage', () => ({
  PHONE_HOST: 'phone',
  phoneProductApi: {},
  phoneSearchRows: (items: unknown[]) => items,
  useOfferedVersions: () => ({ state: 'value', stale: false, error: null, value: { offered: {}, gone: [] } }),
  phoneMarketCatalog: 'catalog',
  phoneMarketRows: () => [],
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

const { MobileAppsSection } = await import('../../../../apps/desktop/src/components/settings/MobileAppsSection')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

const find = (selector: string) => harness.container.ownerDocument.querySelector<HTMLElement>(selector)

it('the installed list read before, its read again failing: the banner says so with a retry', async () => {
  market.installedError = new Error('store unreadable')
  try {
    await harness.render(createElement(MobileAppsSection, { mode: 'installed' }))
    expect(find('[data-testid="phone-apps-unreadable"]')).not.toBeNull()
  } finally { market.installedError = null }
})
