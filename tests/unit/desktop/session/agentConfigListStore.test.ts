// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The agent configuration list of a machine (lib/stores/live/agent-config-list.ts): one live subscription per machine
 * while anyone reads it, "not read yet" apart from "read", and the account's: a sign-out or another account clears it.
 */
const wire = vi.hoisted(() => ({ opened: 0, disposed: 0, value: {} as Record<string, unknown>, listeners: new Set<() => void>() }))
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({ agents: { state: () => ({}) } }),
}))
vi.mock('@gugu/session-wire', async (original) => {
  const { observable, runInAction } = await import('mobx')
  const box = observable.box<Record<string, unknown>>({})
  wire.listeners.add(() => runInAction(() => box.set({ ...wire.value })))
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

beforeEach(() => {
  vi.resetModules()
  wire.opened = 0; wire.disposed = 0; wire.value = {}
})

describe('agent configuration list store', () => {
  it('is unknown until the machine answers, then its list; one subscription per machine while read', async () => {
    const { agentConfigList } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/live/agent-config-list')
    const list = agentConfigList(null)
    expect(list.get()).toEqual({ state: 'unknown' })
    wire.value = { claude: { auth: null } }
    const offA = list.subscribe(() => {})
    const offB = agentConfigList(null).subscribe(() => {})
    await vi.waitFor(() => expect(list.get()).toEqual({ state: 'value', value: { claude: { auth: null } } }))
    expect(wire.opened).toBe(1)
    offA(); offB()
    expect(wire.disposed).toBe(1)
    // The last answer stays shown until a new subscription answers again.
    expect(list.get()).toMatchObject({ state: 'value' })
  })

  it('an empty list is a value, not unknown', async () => {
    const { agentConfigList } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/live/agent-config-list')
    const off = agentConfigList('machine-1').subscribe(() => {})
    await vi.waitFor(() => expect(agentConfigList('machine-1').get()).toEqual({ state: 'value', value: {} }))
    off()
  })

  it('clears on sign-out and on another account; a mere absent session (boot restore) holds', async () => {
    const { publishRendererSession } = await import('../../../../apps/desktop/src/lib/sessionPublication')
    const { agentConfigList } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/live/agent-config-list')
    const session = (id: string) => ({ user: { id } }) as never
    publishRendererSession('SIGNED_IN', session('alice'))
    const off = agentConfigList(null).subscribe(() => {})
    await vi.waitFor(() => expect(agentConfigList(null).get()).toMatchObject({ state: 'value' }))
    publishRendererSession('BOOT_RESTORING', null)
    expect(agentConfigList(null).get()).toMatchObject({ state: 'value' })
    publishRendererSession('SIGNED_IN', session('bob'))
    expect(agentConfigList(null).get()).toEqual({ state: 'unknown' })
    // Still read where shown: bob's list is read again.
    await vi.waitFor(() => expect(agentConfigList(null).get()).toMatchObject({ state: 'value' }))
    expect(wire.opened).toBe(2)
    publishRendererSession('SIGNED_OUT', null)
    expect(agentConfigList(null).get()).toEqual({ state: 'unknown' })
    off()
  })
})
