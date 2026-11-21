// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * A host's connection reads, asked again as before PR 3: behind the assistant panel a failure that may pass (its computer
 * waking) is retried and, while it fails so, asked again every 30 s; another machine is not retried (offline, it would only
 * hang).
 */
const fixture = vi.hoisted(() => ({ accounts: vi.fn(), statuses: vi.fn() }))
const host = vi.hoisted(() => ({ run: 0, value: null as null | Record<string, unknown> }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', () => ({
  isTooOld: () => false, useLibraryHost: () => host.value, keepLibraryHost: (h: unknown) => h, libraryHostOf: () => host.value, peekLibraryHost: () => host.value,
}))
const { integrationAccounts, integrationStatuses } = await import('../../../../apps/desktop/src/components/connections/connection-replicas')
const { useReplica } = await import('../../../../apps/desktop/src/lib/replica')

const waking = () => Object.assign(new Error('waking'), { code: 'unavailable' })
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.useFakeTimers(); h = createReactHarness(); host.run += 1; fixture.accounts.mockReset(); fixture.statuses.mockReset() })
afterEach(() => { h.cleanup(); vi.useRealTimers() })
const panelHost = () => ({ key: `cloud-${host.run}`, assistantPanel: {}, assistantPanelExpected: true, integrations: { accounts: fixture.accounts, checkAllConnections: fixture.statuses } })

it('behind the assistant panel: an account read failing while its computer wakes is retried, then asked again every 30 s', async () => {
  host.value = panelHost()
  fixture.accounts.mockRejectedValue(waking())
  function Probe() { useReplica(integrationAccounts, [host.value!.key as string, 'mail']); return null }
  await h.render(<Probe />)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(fixture.accounts).toHaveBeenCalledTimes(3)
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
  expect(fixture.accounts.mock.calls.length).toBeGreaterThan(3)
})

it('another machine: a failed status read is said at once, ❌ retried', async () => {
  host.value = { key: `remote:d-${host.run}`, remote: { deviceId: 'd', online: true }, integrations: { checkAllConnections: fixture.statuses } }
  fixture.statuses.mockRejectedValue(waking())
  function Probe() { useReplica(integrationStatuses, [host.value!.key as string]); return null }
  await h.render(<Probe />)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(fixture.statuses).toHaveBeenCalledTimes(1)
})
