// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformCatalogModel } from '../../../../apps/desktop/src/lib/agentModelSelection'

/**
 * Models whose value grows with the account's data keep what the first frame needs and still fit their declared limit
 * with many entries (@@@client-state-model, persistence): the platform catalog keeps its enabled models, the usage page's
 * device filter keeps device ids.
 */
const reads = vi.hoisted(() => ({ catalog: [] as PlatformCatalogModel[], usageDevices: [] as { deviceId: string }[] }))
vi.mock('../../../../apps/desktop/src/lib/agentModelSelection', async (original) => ({
  ...(await original<object>()),
  fetchPlatformModelCatalog: async () => reads.catalog,
}))
vi.mock('../../../../apps/desktop/src/lib/usage/cloud', async (original) => ({
  ...(await original<object>()),
  fetchUsageDevices: async () => reads.usageDevices,
}))

const ACCOUNT = 'eb12875b-0000-4000-8000-000000000001'

async function start() {
  // A new renderer process: module state gone, localStorage kept (what a restart keeps).
  vi.resetModules()
  const replica = await import('../../../../apps/desktop/src/lib/replica')
  const { platformModels } = await import('../../../../apps/desktop/src/lib/agentModelReplicas')
  const { usageDevices } = await import('../../../../apps/desktop/src/components/usage/useUsageData')
  return { replica, platformModels, usageDevices }
}

// As the catalog reads today (enabled rows ~360 B, the largest 400 B): three protocols, a multiplier per protocol, reasoning levels.
const model = (i: number, enabled: boolean): PlatformCatalogModel => ({
  id: `vendor-model-${i}.5-flash`, displayName: `Vendor Model ${i}.5 Flash`,
  protocols: ['anthropic-messages', 'openai-chat-completions', 'openai-responses'], enabled, requiresMembership: i % 3 === 0, hidden: false,
  creditMultiplier: null, creditMultipliers: { 'anthropic-messages': 0.161232, 'openai-chat-completions': 0.161232, 'openai-responses': 0.161232 },
  contextWindow: 1048576, reasoningEfforts: ['low', 'medium', 'high', 'max'],
})

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
})
afterEach(() => { vi.restoreAllMocks() })

describe('kept parts across a restart', () => {
  it('the platform catalog keeps its 28 enabled models of 70 (each drawn as read), not the disabled ones', async () => {
    reads.catalog = Array.from({ length: 70 }, (_, i) => model(i, i < 28))
    expect(Math.max(...reads.catalog.map((entry) => JSON.stringify(entry).length)), 'as large as the largest model read today').toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(reads.catalog).length, 'the catalog as read outgrows the limit').toBeGreaterThan(12288)
    const refused = vi.spyOn(console, 'error')
    const first = await start()
    first.replica.followRendererSession('SIGNED_IN', ACCOUNT)
    await first.platformModels.prefetch()
    expect(refused.mock.calls.flat().join(' ')).not.toContain('not kept across restarts')

    const next = await start()
    const reading = next.platformModels.peek()
    expect(reading).toMatchObject({ state: 'value', stale: true })
    expect(reading.state === 'value' && reading.value).toEqual(reads.catalog.filter((entry) => entry.enabled))
  })

  it('the usage device filter keeps 35 devices', async () => {
    reads.usageDevices = Array.from({ length: 35 }, (_, i) => ({ deviceId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }))
    const refused = vi.spyOn(console, 'error')
    const first = await start()
    first.replica.followRendererSession('SIGNED_IN', ACCOUNT)
    await first.usageDevices.prefetch()
    expect(refused.mock.calls.flat().join(' ')).not.toContain('not kept across restarts')

    const next = await start()
    expect(next.usageDevices.peek()).toMatchObject({ state: 'value', stale: true, value: reads.usageDevices })
  })
})
