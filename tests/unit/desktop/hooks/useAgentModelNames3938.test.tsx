// @vitest-environment jsdom
// #3938 The member panel's model cell: models of the shown agents read from presence `model_name`, keyed by agent id.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const store = vi.hoisted(() => {
  const payloads = new Map<string, { accountStatus: string; modelName: string | null }>()
  const listeners = new Map<string, Set<() => void>>()
  return {
    payloads,
    set(id: string, payload: { accountStatus: string; modelName: string | null }) {
      payloads.set(id, payload)
      for (const listener of listeners.get(id) ?? []) listener()
    },
    subscribe(id: string, listener: () => void) {
      let set = listeners.get(id)
      if (!set) listeners.set(id, set = new Set())
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }
})

vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore', () => ({
  getAgentPresenceSnapshot: (id: string) => (store.payloads.has(id) ? { payload: store.payloads.get(id) } : null),
  subscribeAgentPresence: (id: string, listener: () => void) => store.subscribe(id, listener),
}))

const { useAgentModelNames } = await import('../../../../apps/desktop/src/hooks/useAgentModelName')

let harness = createReactHarness()
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); store.payloads.clear() })

let seen: Readonly<Record<string, string>> = {}
function Probe({ ids }: { ids: readonly string[] }) {
  seen = useAgentModelNames(ids)
  return null
}

describe('#3938 useAgentModelNames', () => {
  it('keys each known model by agent id; an unknown, empty or removed one is absent', async () => {
    store.payloads.set('a', { accountStatus: 'active', modelName: 'Opus 5.5' })
    store.payloads.set('b', { accountStatus: 'active', modelName: null })
    store.payloads.set('c', { accountStatus: 'removed', modelName: 'Codex' })
    store.payloads.set('d', { accountStatus: 'active', modelName: '' })
    await harness.render(createNode(Probe, { ids: ['a', 'b', 'c', 'd', 'e'] }))
    expect(seen).toEqual({ a: 'Opus 5.5' })
  })

  it('follows a presence change of a shown agent', async () => {
    store.payloads.set('a', { accountStatus: 'active', modelName: 'Opus 5.5' })
    await harness.render(createNode(Probe, { ids: ['a'] }))
    await act(async () => { store.set('a', { accountStatus: 'active', modelName: 'Sonnet 5.5' }) })
    expect(seen).toEqual({ a: 'Sonnet 5.5' })
  })

  it('another set of ids reads those agents at once, never the previous set', async () => {
    store.payloads.set('a', { accountStatus: 'active', modelName: 'Opus 5.5' })
    store.payloads.set('b', { accountStatus: 'active', modelName: 'Codex' })
    await harness.render(createNode(Probe, { ids: ['a'] }))
    await harness.render(createNode(Probe, { ids: ['b'] }))
    expect(seen).toEqual({ b: 'Codex' })
  })
})
