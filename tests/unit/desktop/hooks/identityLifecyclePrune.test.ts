// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chat, createNode, createReactHarness, displayIdentity } from '../../../support/testHarness'

const realtime = vi.hoisted(() => ({ onSubscribed: undefined as undefined | (() => void) }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribeAuthenticatedRealtimeChannel: (_open: unknown, _name: string, options: { onSubscribed: () => void }) => {
    realtime.onSubscribed = options.onSubscribed
    return {}
  },
  unsubscribeAuthenticatedRealtimeChannel: async () => {},
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ dataClient: { channel: () => ({ on: () => ({}) }) } }))
const reads = vi.hoisted(() => ({ ids: [] as string[][] }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: vi.fn(async (ids: string[]) => { reads.ids.push([...ids].sort()); return [] }),
}))
vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore', () => ({ refreshObservedAgentPresenceFromRevision: vi.fn(async () => {}) }))

const { useIdentityLifecycle } = await import('../../../../apps/desktop/src/hooks/useIdentityLifecycle')
const { openImRepository } = await import('../../../../apps/desktop/src/lib/imRepository')
const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')

const harness = createReactHarness()
afterEach(() => { harness.cleanup(); reads.ids = []; realtime.onSubscribed = undefined })

describe('identity lifecycle reconnect', () => {
  it('re-reads only identities the conversation list or contacts still name: an archived agent is not asked for again', async () => {
    const repository = await openImRepository('me', { adapter: createMemoryLocalSyncDb() })
    const agent = (id: string) => displayIdentity(id, { type: 'agent', owner_user_id: 'me' })
    // Cached before the archive: the account, a friend, a live agent with its DM, and an archived agent whose DM
    // has since left the list (its identity, membership and a cached message stay behind).
    await repository.transaction((transaction) => {
      for (const identity of [displayIdentity('me'), displayIdentity('friend'), agent('live'), agent('archived')]) transaction.putIdentity(identity)
      transaction.putChat('dm-live', chat({ id: 'dm-live', kind: 'dm', peer_user_id: 'live' }))
      transaction.putMembership('dm-live', 'live', {})
      transaction.putMembership('dm-archived', 'archived', {})
    })
    let contactIds: string[] | null = ['friend', 'live']
    const reload = vi.fn(async () => {})
    function Probe() { useIdentityLifecycle('me', async () => repository, reload, () => contactIds); return null }
    await harness.render(createNode(Probe))
    await vi.waitFor(() => expect(realtime.onSubscribed).toBeTypeOf('function'))

    realtime.onSubscribed!()
    await vi.waitFor(() => expect(reads.ids).toHaveLength(1))
    expect(reload).toHaveBeenCalledTimes(1)
    expect(reads.ids[0]).toEqual(['friend', 'live', 'me'])
    expect(repository.snapshot().identity.map((row) => row.id).sort()).toEqual(['friend', 'live', 'me'])

    // Contacts not read yet: nothing is dropped on a guess.
    await repository.putIdentities([displayIdentity('stranger')])
    contactIds = null
    realtime.onSubscribed!()
    await vi.waitFor(() => expect(reads.ids).toHaveLength(2))
    expect(reads.ids[1]).toContain('stranger')
  })
})
