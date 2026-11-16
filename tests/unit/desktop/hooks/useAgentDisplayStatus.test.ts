// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, deferred } from '../../../support/testHarness'

// The hooks over the real agent presence store (and its `agentPresenceReadable` adapter); only the store's transport is
// played here: the presence batch read (identity RPC) and no desktop host.
const transport = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ dataClient: { schema: () => ({ rpc: transport.rpc }) } }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => null }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))
const { useAgentDisplayStatus, useAgentDisplayStatuses } = await import('../../../../apps/desktop/src/hooks/useAgentDisplayStatus')
const { agentPresenceReadable, getAgentPresenceSnapshot, prewarmAgentPresence, setLocalAgentStatus, setPresenceBusContext } = await import('../../../../apps/desktop/src/lib/agentPresenceStore')

type Activity = 'idle' | 'running'
const presence = (agentUserId: string, activity: Activity) => ({
  status: 'presence',
  presence: {
    agent_user_id: agentUserId, account_status: 'active', runtime_status: 'online', desired_status: 'online', activity_status: activity,
    device_id: 'dev-1', device_status: 'online', device_last_seen_at: new Date().toISOString(), updated_at: '2026-08-21T00:00:00Z',
  },
})
/** The batch read answers every id it is asked about with `activity`. */
const answer = (activity: Activity) => (_name: string, args: { p_agent_user_ids?: string[] }) =>
  Promise.resolve({ data: { results: Object.fromEntries((args.p_agent_user_ids ?? []).map((id) => [id, presence(id, activity)])) }, error: null })

let harness: ReturnType<typeof createReactHarness>
let account = 0
// Each case: a fresh agent id under a fresh account (the store keeps what an account observed).
let agent = ''
beforeEach(() => {
  harness = createReactHarness()
  transport.rpc.mockReset().mockImplementation(answer('idle'))
  setPresenceBusContext({ currentUserId: `owner-${++account}` })
  agent = `agent-${account}`
})
afterEach(() => { harness.cleanup() })

describe('useAgentDisplayStatus', () => {
  it('reads the store for the initial status', async () => {
    transport.rpc.mockImplementation(answer('running'))
    await harness.render(createNode(StatusProbe, { agentUserId: agent }))
    await flush()
    expect(transport.rpc).toHaveBeenCalledWith('get_agent_presence_batch', { p_agent_user_ids: [agent] })
    expect(statusText()).toBe('working')
  })
  it('updates when the store changes', async () => {
    await harness.render(createNode(StatusProbe, { agentUserId: agent }))
    await flush()
    expect(statusText()).toBe('idle')
    await act(async () => {
      setLocalAgentStatus(agent, { sessionId: 's', reading: { status: 'working', detail: 'running', running: true, background: null },
        unseen: false, reviewGate: null, providerBlocker: null, statusSourceFault: null, life: { kind: 'ready', stage: null } })
    })
    expect(statusText()).toBe(getAgentPresenceSnapshot(agent)!.status)
    expect(statusText()).toBe('working')
  })
  it('unsubscribes from the store on unmount: an account switch drops the entry nobody watches', async () => {
    await harness.render(createNode(StatusProbe, { agentUserId: agent }))
    await flush()
    harness.cleanup()
    setPresenceBusContext({ currentUserId: `owner-${++account}` })
    expect(getAgentPresenceSnapshot(agent)).toBeNull()
  })
  it('does not subscribe when agentUserId is missing', async () => {
    await harness.render(createNode(StatusProbe, { agentUserId: null }))
    await flush()
    expect(transport.rpc).not.toHaveBeenCalled()
    expect(statusText()).toBe('pending')
  })
})

describe('agentPresenceReadable', () => {
  it('an agent never observed reads one stable pending state (a reader comparing by reference does not loop)', () => {
    const readable = agentPresenceReadable(`${agent}-unseen`)
    const first = readable.get()
    expect(first).toMatchObject({ status: 'pending', source: 'pending' })
    expect(readable.get()).toBe(first)
    expect(agentPresenceReadable(`${agent}-unseen`)).toBe(readable)
  })
  it('an observed agent reads the stored state, and its listener hears the change', async () => {
    const readable = agentPresenceReadable(agent)
    const heard = vi.fn()
    const stop = readable.subscribe(heard)
    try {
      await flush()
      expect(readable.get()).toBe(getAgentPresenceSnapshot(agent))
      expect(readable.get().status).toBe('idle')
      heard.mockClear()
      setLocalAgentStatus(agent, { sessionId: 's', reading: { status: 'working', detail: 'running', running: true, background: null },
        unseen: false, reviewGate: null, providerBlocker: null, statusSourceFault: null, life: { kind: 'ready', stage: null } })
      expect(heard).toHaveBeenCalled()
      expect(readable.get().status).toBe('working')
    } finally { stop() }
  })
  it('the empty id subscribes to nothing', async () => {
    const stop = agentPresenceReadable('').subscribe(() => undefined)
    await flush()
    stop()
    expect(transport.rpc).not.toHaveBeenCalled()
  })
})

describe('useAgentDisplayStatuses', () => {
  it('does not publish a new map when the stored state is unchanged', async () => {
    prewarmAgentPresence([agent])
    await flush()
    expect(getAgentPresenceSnapshot(agent)?.status).toBe('idle')
    const renders: number[] = []
    function RenderCountProbe({ agentUserIds }: { agentUserIds: string[] }) {
      renders.push(1)
      const statuses = useAgentDisplayStatuses(agentUserIds)
      return createNode('output', { 'data-testid': 'status' }, JSON.stringify(statuses))
    }
    await harness.render(createNode(RenderCountProbe, { agentUserIds: [agent] }))
    await flush()
    expect(statusText()).toBe(JSON.stringify({ [agent]: 'idle' }))
    expect(renders).toHaveLength(1)
  })
  it('does not expose the never-observed pending state as a resolved group status', async () => {
    const read = deferred<unknown>()
    transport.rpc.mockReturnValueOnce(read.promise)
    await harness.render(createNode(StatusesProbe, { agentUserIds: [agent] }))
    await flush()
    expect(getAgentPresenceSnapshot(agent)?.source).toBe('pending')
    expect(statusText()).toBe('{}')
    await act(async () => { read.resolve(await answer('idle')('get_agent_presence_batch', { p_agent_user_ids: [agent] })) })
    await flush()
    expect(statusText()).toBe(JSON.stringify({ [agent]: 'idle' }))
  })
})

function StatusProbe({ agentUserId }: { agentUserId: string | null }) {
  const { status } = useAgentDisplayStatus(agentUserId)
  return createNode('output', { 'data-testid': 'status' }, status)
}
function StatusesProbe({ agentUserIds }: { agentUserIds: string[] }) {
  const statuses = useAgentDisplayStatuses(agentUserIds)
  return createNode('output', { 'data-testid': 'status' }, JSON.stringify(statuses))
}
function statusText(): string {
  return harness.container.querySelector('[data-testid="status"]')?.textContent ?? ''
}
/** The store's batch read (a microtask flush, then the dynamic import of its client and the answer) handed on to React. */
async function flush() {
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => { await vi.dynamicImportSettled() })
  }
}
