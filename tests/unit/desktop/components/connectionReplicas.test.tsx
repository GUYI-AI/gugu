// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import { createReactHarness } from '../../../support/testHarness'
import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'

/** The connections library's replicas (connection-replicas.ts): what reads them again, and how often. */
const net = vi.hoisted(() => ({ snapshot: vi.fn(), epoch: '1' }))
vi.mock('@/lib/connectionBridge', () => ({ connectionBridge: () => ({
  routing: { peek: () => ({ mode: 'owner', epoch: net.epoch }) },
  metadata: () => ({ snapshot: net.snapshot }),
}) }))

const { chatChannels, ownerConnections, integrationStatuses } = await import('../../../../apps/desktop/src/components/connections/connection-replicas')
const { CONNECTIONS_CHANGED } = await import('../../../../apps/desktop/src/components/connections/owner-connection-metadata')
const { useReplica } = await import('../../../../apps/desktop/src/lib/replica')

const pending = { operationId: 'o', revision: '2', domain: 'integrations', resourceKey: 'k', status: 'pending', errorCode: null }
const snapshotWith = (application: unknown[]) => ({ version: 1, revision: '1', items: [], application })
let run = 0
let h: ReturnType<typeof createReactHarness>
function Shown() { useReplica(ownerConnections, ['1', null]); return null }
beforeEach(() => {
  run += 1
  publishRendererSession('SIGNED_IN', { user: { id: `connection-replicas-${run}` }, access_token: 'fixture' } as Session)
  net.snapshot.mockReset()
  h = createReactHarness()
})
afterEach(() => { h.cleanup(); vi.useRealTimers(); publishRendererSession('SIGNED_OUT', null) })

describe('ownerConnections', () => {
  it('asks every 3 s while a connection waits for confirmation, every 15 s otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    net.snapshot.mockResolvedValue(snapshotWith([pending]))
    await h.render(<Shown />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(net.snapshot).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(net.snapshot).toHaveBeenCalledTimes(2)
    // Confirmed: the poll slows down.
    net.snapshot.mockResolvedValue(snapshotWith([]))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(net.snapshot).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(14_000) })
    expect(net.snapshot).toHaveBeenCalledTimes(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(net.snapshot).toHaveBeenCalledTimes(4)
  })

  it('a connection announced changed in this window is read again where shown', async () => {
    net.snapshot.mockResolvedValue(snapshotWith([]))
    const stop = chatChannels.hold()
    await h.render(<Shown />)
    await act(async () => { await vi.waitFor(() => expect(ownerConnections.peek('1', null).state).toBe('value')) })
    const reads = net.snapshot.mock.calls.length
    await act(async () => { window.dispatchEvent(new CustomEvent(CONNECTIONS_CHANGED, { detail: {} })) })
    await act(async () => { await vi.waitFor(() => expect(net.snapshot.mock.calls.length).toBe(reads + 1)) })
    stop()
  })

  it('a key read under an older route epoch is refused, ❌ answered with the new route\'s rows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    net.epoch = '2'
    const read = ownerConnections.fetch('1', null)
    const refused = expect(read).rejects.toMatchObject({ code: 'route-changed' })
    // Its retries (with backoff) run out on the fake clock.
    await vi.advanceTimersByTimeAsync(60_000)
    await refused
    expect(net.snapshot).not.toHaveBeenCalled()
    net.epoch = '1'
  })
})

describe('host-keyed integration models', () => {
  it('a host nobody keeps is a read that fails loud (❌ an empty answer)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const refused = expect(integrationStatuses.fetch(`never-kept-${run}`)).rejects.toThrow('No library host is kept')
    await vi.advanceTimersByTimeAsync(60_000)
    await refused
  })
})
