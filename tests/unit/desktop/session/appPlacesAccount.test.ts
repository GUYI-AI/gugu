// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

/**
 * Independent review: which agents and groups an App is given to (D-30) are the signed-in account's agents and groups.
 * After A signs out and B signs in, B's App page must not draw A's places (❌ device scope, which no account switch clears).
 */
const places = vi.hoisted(() => ({ owner: 'owner-a' }))
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: { appPlaces: async () => ({ success: true, data: [{ kind: 'agent', id: `${places.owner}-agent` }] }) } },
  rpcOn: () => ({ extensions: {} }), onMachineEvent: () => () => undefined, events: { on: () => () => undefined },
}))
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: vi.fn() } }))

const { appPlaces } = await import('@renderer/features/extensions/market-replicas')
const { followRendererSession } = await import('@/lib/replica')

beforeEach(() => { places.owner = 'owner-a'; followRendererSession('SIGNED_IN', 'owner-a') })

it("B signing in after A does not see A's places for an App (unknown until read for B)", async () => {
  await appPlaces.prefetch('local', 'notes')
  expect(appPlaces.peek('local', 'notes')).toMatchObject({ state: 'value', value: [{ id: 'owner-a-agent' }] })
  followRendererSession('SIGNED_OUT', null)
  places.owner = 'owner-b'
  followRendererSession('SIGNED_IN', 'owner-b')
  expect(appPlaces.peek('local', 'notes')).toEqual({ state: 'unknown' })
  await appPlaces.prefetch('local', 'notes')
  expect(appPlaces.peek('local', 'notes')).toMatchObject({ state: 'value', value: [{ id: 'owner-b-agent' }] })
})
