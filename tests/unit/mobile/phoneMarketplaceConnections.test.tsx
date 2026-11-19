// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { i18n, setLocalePreference } from '../../../apps/desktop/src/i18n'
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { PhoneMarketConnections } from '../../../apps/desktop/src/mobile/market/PhoneMarketConnections'
import { createReactHarness } from '../../support/testHarness'

vi.mock('@/components/connections/ConnectionRouteBoundary', () => ({
  ConnectionRouteBoundary: ({ legacy }: { legacy: ReactNode }) => legacy,
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

it('renders the shared connector catalog before the staging account has an assistant', async () => {
  setLocalePreference('zh-CN')
  await harness.render(<I18nextProvider i18n={i18n}>
    <PhoneMarketConnections assistant={undefined} mode="market" devices={[]} installedDeviceId={null} />
  </I18nextProvider>)
  const github = harness.container.querySelector('[data-testid="phone-market-connector-github"]')
  expect(github?.textContent).toContain('GitHub')
  expect(github?.querySelector('svg,img')).not.toBeNull()
  expect(github?.querySelector('button')).toBeNull()
})
