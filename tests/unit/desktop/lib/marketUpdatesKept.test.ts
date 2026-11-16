// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

/**
 * Coordinator 11-16: the updates of this computer's Apps are kept across restarts as a bounded projection — at most 16
 * Apps named — and not at all beyond (❌ a raised cap, ❌ a write refused at every read): the cold badge then waits.
 */
const market = vi.hoisted(() => ({ updates: {} as Record<string, { version: string }> }))
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: { marketUpdates: async () => ({ success: true, data: { updates: market.updates, yanked: {}, deprecated: {}, gone: [] } }) } },
  rpcOn: () => ({ extensions: {} }), onMachineEvent: () => () => undefined, events: { on: () => () => undefined },
}))
const errors = vi.hoisted(() => vi.fn())
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error: errors }) }))

const { marketUpdates, LOCAL_HOST } = await import('@renderer/features/extensions/installed-extensions')
const keptNames = () => Object.values(JSON.parse(localStorage.getItem('gugu.readModel.v1:device') ?? '{}') as Record<string, { key: unknown[] }>)
  .filter((entry) => entry.key[0] === 'marketUpdates')
const named = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`app-${String(index).padStart(2, '0')}-xxxxxxxx`, { version: '1.2.3' }]))

beforeEach(() => { localStorage.clear(); errors.mockClear() })

it('kept while at most 16 Apps are named; not kept beyond, and no refused write is reported', async () => {
  market.updates = named(16)
  await marketUpdates.fetch(LOCAL_HOST)
  expect(keptNames()).toHaveLength(1)
  market.updates = named(20)
  await marketUpdates.refresh(LOCAL_HOST); await marketUpdates.fetch(LOCAL_HOST)
  expect(keptNames()).toHaveLength(0)
  expect(errors).not.toHaveBeenCalled()
})
