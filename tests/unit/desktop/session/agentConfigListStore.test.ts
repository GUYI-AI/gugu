// @vitest-environment jsdom
import { QueryObserver } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The agent configuration list of a machine (lib/stores/live/agent-config-list.ts): a replica entry read once and fed by
 * one live subscription per machine while shown (`watch`); "not read yet" apart from "read"; the account's (the replica's
 * lifecycle). A subscription that failed is the reading's (review C-9), ❌ an error every later reader of that machine
 * gets while one stays: a surface opening later reads again, and the feed opens again once the machine answers.
 */
const wire = vi.hoisted(() => ({ opened: 0, disposed: 0, value: {} as Record<string, unknown>, push: () => {}, client: vi.fn() }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({ getAgentConfigRuntimeClient: () => wire.client() }))
vi.mock('@gugu/session-wire', async (original) => {
  const { observable, runInAction } = await import('mobx')
  const box = observable.box<Record<string, unknown>>({})
  wire.push = () => runInAction(() => box.set({ ...wire.value }))
  return {
    ...await original<object>(),
    ReplicaState: class {
      ready = Promise.resolve()
      constructor() { wire.opened++; runInAction(() => box.set({ ...wire.value })) }
      current() { return box.get() }
      dispose() { wire.disposed++; return Promise.resolve() }
    },
  }
})

const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')
const { agentConfigList } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/live/agent-config-list')
const show = (machine: string | null) =>
  new QueryObserver(queryClient, agentConfigList.options(agentConfigList.key(machine)!) as never).subscribe(() => {})
const client = { agents: { state: () => ({}) } }

beforeEach(() => {
  queryClient.clear()
  wire.opened = 0; wire.disposed = 0; wire.value = {}
  wire.client.mockReset().mockResolvedValue(client)
  followRendererSession('SIGNED_IN', 'tester')
})

describe('agent configuration list', () => {
  it('is unknown until the machine answers, then its list, kept current by one feed per machine while shown', async () => {
    expect(agentConfigList.peek(null)).toEqual({ state: 'unknown' })
    wire.value = { claude: { auth: null } }
    const offA = show(null)
    const offB = show(null)
    await vi.waitFor(() => expect(agentConfigList.peek(null)).toMatchObject({ state: 'value', value: { claude: { auth: null } } }))
    // The read and one live feed for the machine, however many show it.
    await vi.waitFor(() => expect(wire.opened).toBe(2))
    wire.value = { claude: { auth: { status: { kind: 'signed-in' } } } }
    wire.push()
    await vi.waitFor(() => expect(agentConfigList.peek(null)).toMatchObject({ value: { claude: { auth: { status: { kind: 'signed-in' } } } } }))
    offA(); offB()
    // The read's own subscription and the feed both closed; the last answer stays.
    await vi.waitFor(() => expect(wire.disposed).toBe(2))
    expect(agentConfigList.peek(null)).toMatchObject({ state: 'value' })
  })

  it('an empty list is a value, not unknown', async () => {
    const off = show('machine-1')
    await vi.waitFor(() => expect(agentConfigList.peek('machine-1')).toMatchObject({ state: 'value', value: {} }))
    off()
  })

  it('a failed subscription is an error a surface opening later reads past, and the feed opens again', async () => {
    wire.client.mockRejectedValue(new Error('wire down'))
    const first = show(null)
    await vi.waitFor(() => expect(agentConfigList.peek(null).state).toBe('error'))
    wire.client.mockResolvedValue(client)
    const later = show(null)
    await vi.waitFor(() => expect(agentConfigList.peek(null)).toMatchObject({ state: 'value', error: null }))
    await vi.waitFor(() => expect(wire.opened).toBe(2))
    wire.value = { codex: { auth: null } }
    wire.push()
    await vi.waitFor(() => expect(agentConfigList.peek(null)).toMatchObject({ value: { codex: { auth: null } } }))
    first(); later()
  })
})
