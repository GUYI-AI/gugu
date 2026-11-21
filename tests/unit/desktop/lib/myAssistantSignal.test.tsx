// @vitest-environment jsdom
// `myAssistant` is signal tier (agent_provisions writes no account revision): while a surface shows it, a resubscription of
// the account's private bus reads it again (a gap where another device may have provisioned or moved it); the first
// subscription does not (the mount reads already).
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { notifyManager } from '@tanstack/react-query'
import { createNode, createReactHarness } from '../../../support/testHarness'

const reads = vi.hoisted(() => ({ count: 0 }))
const bus = vi.hoisted(() => ({ onSubscribed: [] as Array<() => void>, unsubscribed: 0 }))
vi.mock('@/lib/supabase', () => ({
  identityDb: { from: () => ({ select: () => ({ eq: () => ({ eq: async () => { reads.count++; return { data: [], error: null } } }) }) }) },
}))
vi.mock('@/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_user: string, _event: string, _listener: unknown, options: { onSubscribed?: () => void }) => {
    bus.onSubscribed.push(options.onSubscribed!)
    return { id: bus.onSubscribed.length }
  },
  unsubscribePrivateUserEventBus: () => { bus.unsubscribed++ },
}))
vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const { useMyAssistant } = await import('@/lib/myAssistant')
const { followRendererSession, queryClient } = await import('@/lib/replica')

function Probe() {
  const reading = useMyAssistant()
  return <span data-testid="mine">{reading.state}</span>
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  queryClient.clear()
  followRendererSession('SIGNED_IN', 'owner')
  reads.count = 0
  bus.onSubscribed.length = 0
  bus.unsubscribed = 0
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

it('reads on mount, not again for the first subscription, again on each resubscription; one bus listener for all readers', async () => {
  await harness.render(createNode('div', {}, createNode(Probe, {}), createNode(Probe, {})))
  await vi.waitFor(() => expect(harness.container.textContent).toBe('valuevalue'))
  expect(reads.count).toBe(1)
  expect(bus.onSubscribed).toHaveLength(1)
  await act(async () => { bus.onSubscribed[0]!() })
  expect(reads.count).toBe(1)
  await act(async () => { bus.onSubscribed[0]!() })
  await vi.waitFor(() => expect(reads.count).toBe(2))
  harness.cleanup()
  expect(bus.unsubscribed).toBe(1)
})
