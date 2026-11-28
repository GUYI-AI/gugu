// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { createNode, createReactHarness } from '../../../support/testHarness'

type Opened = { name: string; onSubscribed: () => void; onStatus: (status: string) => void; closed: boolean }
const realtime = vi.hoisted(() => ({ opened: [] as Opened[] }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribeAuthenticatedRealtimeChannel: (_open: unknown, name: string, options: { onSubscribed: () => void; onStatus: (status: string) => void }) => {
    const opened = { name, onSubscribed: options.onSubscribed, onStatus: options.onStatus, closed: false }
    realtime.opened.push(opened)
    return opened
  },
  unsubscribeAuthenticatedRealtimeChannel: async (handle: Opened) => { handle.closed = true },
}))
// Each batch read waits until the test answers it with the agents' server state at that moment.
type Read = { ids: string[]; answer: (seqs: Record<string, number>) => void }
const server = vi.hoisted(() => ({ reads: [] as Read[] }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: {
    channel: () => ({ on: () => ({}) }),
    schema: () => ({
      rpc: (_name: string, { p_agent_user_ids: ids }: { p_agent_user_ids: string[] }) => new Promise((resolve) => {
        server.reads.push({ ids: [...ids].sort(), answer: (seqs) => resolve({ error: null, data: { results: Object.fromEntries(ids.map((id) => [id, { status: 'presence', presence: presence(id, seqs[id]) }])) } }) })
      }),
    }),
  },
}))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => null }))

function presence(agentUserId: string, seq: number) {
  return { agent_user_id: agentUserId, account_status: 'active', updated_at: `2026-11-28T00:00:${String(seq).padStart(2, '0')}.000Z`, agent_status: seq % 2 ? 'working' : 'idle', seq }
}

const store = await import('../../../../apps/desktop/src/lib/agentPresenceStore')
const { chatPresenceChannel, useAgentPresenceChannel } = await import('../../../../apps/desktop/src/lib/agentPresenceChannels')

let harness: ReturnType<typeof createReactHarness>
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const seqOf = (id: string) => store.getAgentPresenceSnapshot(id)?.payload?.seq ?? null
let account = 0
function signIn() {
  store.setPresenceBusContext({ currentUserId: null })
  store.setPresenceBusContext({ currentUserId: `me-${++account}` })
}
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); realtime.opened = []; server.reads = [] })

function Panel({ chatId, agents }: { chatId: string | null; agents: string[] }) {
  useAgentPresenceChannel(chatId ? chatPresenceChannel(chatId) : null, agents)
  return null
}
function Dot({ id }: { id: string }) {
  useEffect(() => store.subscribeAgentPresence(id, () => undefined), [id])
  return null
}

describe('agent presence channels', () => {
  it('opens a chat with one read, after its channel subscribed', async () => {
    signIn()
    await harness.render(createNode('div', null, createNode(Dot, { id: 'a1' }), createNode(Panel, { chatId: 'c1', agents: ['a1'] })))
    await settle()
    expect(server.reads).toHaveLength(0)

    realtime.opened[0]!.onSubscribed()
    await settle()
    expect(server.reads.map((read) => read.ids)).toEqual([['a1']])
    server.reads[0]!.answer({ a1: 3 })
    await settle()
    expect(seqOf('a1')).toBe(3)
  })

  it('reads again after subscribing when a read started before it is still in flight', async () => {
    signIn()
    await harness.render(createNode(Dot, { id: 'a2' }))
    await settle()
    expect(server.reads).toHaveLength(1)

    await harness.render(createNode('div', null, createNode(Dot, { id: 'a2' }), createNode(Panel, { chatId: 'c2', agents: ['a2'] })))
    realtime.opened[0]!.onSubscribed()
    await settle()
    // The change committed between the first read and the join (seq 4 → 5) is only in a read sent after the join.
    server.reads[0]!.answer({ a2: 4 })
    await settle()
    expect(server.reads).toHaveLength(2)
    server.reads[1]!.answer({ a2: 5 })
    await settle()
    expect(seqOf('a2')).toBe(5)
  })

  it('shares one subscription between two holders of a chat, and keeps it until the last one lets go', async () => {
    signIn()
    const both = (first: string | null, second: string | null) => createNode('div', null,
      createNode(Dot, { id: 'a3' }),
      createNode(Panel, { chatId: first, agents: ['a3'] }),
      createNode(Panel, { chatId: second, agents: ['a3'] }))
    await harness.render(both('c3', 'c3'))
    expect(realtime.opened.map((opened) => opened.name)).toEqual(['presence:chat:c3'])
    realtime.opened[0]!.onSubscribed()
    await settle()
    server.reads[0]!.answer({ a3: 6 })
    await settle()

    await harness.render(both(null, 'c3'))
    expect(realtime.opened[0]!.closed).toBe(false)
    // Still carried: a broadcast lands.
    store.applyAgentPresenceBroadcast('presence:chat:c3', { presence: presence('a3', 7) })
    await settle()
    expect(seqOf('a3')).toBe(7)

    await harness.render(both(null, null))
    await settle()
    expect(realtime.opened[0]!.closed).toBe(true)
    expect(realtime.opened).toHaveLength(1)
  })

  it('reads once for whoever is looking when the channel never subscribes', async () => {
    signIn()
    await harness.render(createNode('div', null, createNode(Dot, { id: 'a4' }), createNode(Panel, { chatId: 'c4', agents: ['a4'] })))
    await settle()
    expect(server.reads).toHaveLength(0)
    realtime.opened[0]!.onStatus('CHANNEL_ERROR')
    await settle()
    expect(server.reads.map((read) => read.ids)).toEqual([['a4']])
  })
})
