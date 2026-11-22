// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * Another machine's integrations once read, then the machine goes offline: it is not asked, and what was read of it stays
 * drawn (❌ an empty list, every connection "checking" forever) — as the App page and the MCP library do.
 */
const api = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: 'linear', name: 'Linear', description: '', auth: { methods: [] }, features: [] }]),
  checkAllConnections: vi.fn(async () => ({ linear: { connected: true } })),
  checkConfiguredConnections: vi.fn(async () => ({ linear: true })),
  accounts: vi.fn(async () => [{ accountId: 'a', displayName: 'me', fields: {}, connectedAt: '2026-10-01T00:00:00Z' }]),
  checkAccounts: vi.fn(async () => []),
}))
const host = vi.hoisted(() => ({ run: 0, value: null as null | Record<string, unknown> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', () => ({
  isTooOld: () => false, useLibraryHost: () => host.value, keepLibraryHost: (h: unknown) => h, libraryHostOf: () => host.value, peekLibraryHost: () => host.value,
}))

const { IntegrationsProvider, useIntegrationsContext } = await import('../../../../apps/desktop/src/session/renderer/features/integrations/integrations-provider')
const { useIntegrationAccounts } = await import('../../../../apps/desktop/src/session/renderer/features/integrations/use-integration-accounts')

let h: ReturnType<typeof createReactHarness>
const machine = (online: boolean) => ({ key: `remote:d-${host.run}`, remote: { deviceId: `d-${host.run}`, deviceLabel: 'Studio', online, lastSeenAt: null }, integrations: api })
beforeEach(() => { h = createReactHarness(); host.run += 1; vi.clearAllMocks() })
afterEach(() => h.cleanup())

let seen: { integrations: unknown; checking: boolean; accounts: string } | null = null
function Probe() {
  const context = useIntegrationsContext()
  const { accounts } = useIntegrationAccounts('linear', true, { check: false })
  seen = { integrations: context.integrations, checking: context.isCheckingConnections, accounts: accounts.state }
  return null
}
const render = () => h.render(<IntegrationsProvider><Probe /></IntegrationsProvider>)

it('read online, then offline: the list, statuses and accounts read stay; nothing is asked; nothing is "checking"', async () => {
  host.value = machine(true)
  await render()
  await vi.waitFor(() => expect(seen?.integrations).not.toBeNull())
  await vi.waitFor(() => expect(seen?.accounts).toBe('value'))
  await vi.waitFor(() => expect(seen?.checking).toBe(false))
  const asked = api.list.mock.calls.length + api.checkAllConnections.mock.calls.length + api.accounts.mock.calls.length
  host.value = machine(false)
  await render()
  expect(seen?.integrations).not.toBeNull()
  expect(seen?.accounts).toBe('value')
  expect(seen?.checking).toBe(false)
  expect(api.list.mock.calls.length + api.checkAllConnections.mock.calls.length + api.accounts.mock.calls.length).toBe(asked)
})

it('offline and never read: nothing is "checking" (its answer would never come)', async () => {
  host.value = machine(false)
  await render()
  expect(seen?.checking).toBe(false)
  expect(api.checkAllConnections).not.toHaveBeenCalled()
})
