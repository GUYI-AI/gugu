// @vitest-environment jsdom
import { hashKey, notifyManager } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Review 4 Q1: the account's model catalog keeps only what a cold first frame draws (the settings → Model list), so the
 * entry stays well under its cap as the server's catalog grows; the earlier names' entries leave the snapshot.
 */
const ACCOUNT = 'account-1'
const BLOCK = `gugu.readModel.v1:${ACCOUNT}`
const io = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/agentModelSelection', async (original) => ({
  ...(await original<object>()),
  fetchPlatformModelCatalog: () => io.read(),
}))

// A row the size of today's catalog rows (≈ 150 B carried; the catalog has ≈ 50 of them).
function row(n: number) {
  return {
    id: `claude-opus-${n}-5`,
    displayName: `Claude Opus ${n}.5`,
    protocols: ['anthropic-messages'],
    enabled: true,
    requiresMembership: n % 3 === 0,
    hidden: n % 5 === 0,
    creditMultiplier: 1.5,
    creditMultipliers: { 'anthropic-messages': 1.5 },
    contextWindow: 1_000_000,
    reasoningEfforts: ['low', 'medium', 'high', 'max'],
  }
}

async function freshStart() {
  vi.resetModules()
  const replica = await import('../../../../apps/desktop/src/lib/replica')
  replica.followRendererSession('SIGNED_IN', ACCOUNT)
  const models = await import('../../../../apps/desktop/src/lib/agentModelReplicas')
  return { replica, catalog: models.platformModels, catalogDetailed: models.catalogDetailed }
}

const block = () => JSON.parse(localStorage.getItem(BLOCK) ?? '{}') as Record<string, { key: unknown[]; value: unknown }>

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  io.read.mockReset()
})

describe('platformCatalog in the snapshot', () => {
  it('keeps the list a cold first frame draws, without the menu details; a catalog twice today’s size still fits', async () => {
    const { catalog } = await freshStart()
    // Twice a 50-row catalog, every row with long names and both protocols.
    io.read.mockResolvedValue(Array.from({ length: 100 }, (_, n) => row(n)))
    await catalog.prefetch()
    const kept = Object.values(block()).find((entry) => entry.key[0] === 'platformCatalog')
    expect(kept).toBeDefined()
    const rows = kept!.value as Record<string, unknown>[]
    expect(rows).toHaveLength(100)
    expect(Object.keys(rows[0]!).sort()).toEqual(['displayName', 'enabled', 'hidden', 'id', 'protocols', 'requiresMembership'])
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(16384)
  })

  it('a restored catalog is not taken as read: no details until the read that follows lands', async () => {
    const first = await freshStart()
    io.read.mockResolvedValue([row(1), row(2)])
    await first.catalog.prefetch()
    const { catalog, catalogDetailed } = await freshStart()
    const restored = catalog.peek()
    expect(restored).toMatchObject({ state: 'value' })
    expect(catalogDetailed((restored as unknown as { value: never[] }).value)).toBe(false)
    await catalog.refresh()
    await catalog.fetch()
    expect(catalogDetailed((catalog.peek() as unknown as { value: never[] }).value)).toBe(true)
  })

  it('the earlier names’ entries leave the snapshot when the module registers (❌ kept 30 days as "not registered yet")', async () => {
    const at = Date.now()
    const stale = Object.fromEntries(['platformModels', 'platformModelsV2'].map((name) => {
      const key = [name, ACCOUNT]
      return [hashKey(key), { key, value: [row(1)], at }]
    }))
    localStorage.setItem(BLOCK, JSON.stringify(stale))
    await freshStart()
    expect(Object.values(block()).map((entry) => entry.key[0])).toEqual([])
  })
})
