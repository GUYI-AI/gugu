// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  rpc: vi.fn(),
  syncSince: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc: db.rpc },
  dataClient: { schema: () => ({ rpc: () => ({ abortSignal: () => db.syncSince() }) }) },
}))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(), unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

import { bindBackendProbe, noteBackendAnswer, subscribeBackendRecovered } from '../../../../packages/core/src/cloud/backendReachability'
import { createSupabaseAccountRevisionSource } from '../../../../apps/desktop/src/lib/supabaseAccountRevisionSource'
import { chatSeq, writeRead } from '../../../../apps/desktop/src/lib/readWriter'
import { readOutboxKind } from '../../../../apps/desktop/src/lib/outbox/kinds/read'
import { createOutbox, type Outbox } from '../../../../apps/desktop/src/lib/outbox/core'
import { fakeAccount, memoryStorage } from '../store/chatOutboxHarness'

const unbinds: Array<() => void> = []
// The window's one outbox with the read kind, over memory, for account 'me'.
let box: Outbox
let account: ReturnType<typeof fakeAccount>
beforeEach(() => {
  account = fakeAccount('me')
  box = createOutbox({ storage: memoryStorage(), account, online: () => () => {} })
  box.register(readOutboxKind)
  ;(globalThis as Record<string, unknown>).__GUGU_OUTBOX__ = box
})
afterEach(() => {
  box.dispose(); delete (globalThis as Record<string, unknown>).__GUGU_OUTBOX__
  vi.useRealTimers()
  for (const unbind of unbinds.splice(0)) unbind(); db.rpc.mockReset(); db.syncSince.mockReset()
})

describe('backend recovered = the sync pull failed, then answered', () => {
  it('fires once on the failed → answered edge, never while the backend keeps answering', () => {
    unbinds.push(bindBackendProbe(() => {}))
    const recovered = vi.fn()
    unbinds.push(subscribeBackendRecovered(recovered))
    noteBackendAnswer(true)
    expect(recovered).not.toHaveBeenCalled()
    noteBackendAnswer(false)
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    noteBackendAnswer(true)
    expect(recovered).toHaveBeenCalledOnce()
  })

  it('reads the edge from sync_since itself: a rejected or refused pull is a failure, an aborted one is no reading', async () => {
    unbinds.push(bindBackendProbe(() => {}))
    const recovered = vi.fn()
    unbinds.push(subscribeBackendRecovered(recovered))
    const source = createSupabaseAccountRevisionSource()
    const live = new AbortController().signal
    db.syncSince.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(source.syncSince('5', 100, live)).rejects.toThrow('Failed to fetch')
    const aborted = new AbortController(); aborted.abort()
    db.syncSince.mockResolvedValueOnce({ data: { operations: [], has_more: false }, error: null })
    await source.syncSince('5', 100, aborted.signal).catch(() => undefined)
    expect(recovered).not.toHaveBeenCalled()
    db.syncSince.mockResolvedValueOnce({ data: { operations: [], has_more: false }, error: null })
    await source.syncSince('5', 100, live).catch(() => undefined)
    expect(recovered).toHaveBeenCalledOnce()
  })

  it('a new account starts from "answering": the last account\'s outage does not fire for it', () => {
    const unbind = bindBackendProbe(() => {})
    noteBackendAnswer(false)
    unbind()
    unbinds.push(bindBackendProbe(() => {}))
    const recovered = vi.fn()
    unbinds.push(subscribeBackendRecovered(recovered))
    noteBackendAnswer(true)
    expect(recovered).not.toHaveBeenCalled()
  })
})

describe('a cloud read that could not be written goes out again when the backend recovers', () => {
  const offline = { data: null, error: { message: 'Failed to fetch' } }
  it('is accepted once on disk, keeps the highest read per stream, asks the beat to pull, and writes it once on recovery', async () => {
    vi.useFakeTimers()
    const pull = vi.fn()
    unbinds.push(bindBackendProbe(pull))
    db.rpc.mockResolvedValue(offline)
    // The local read position is the fact: writing it never fails for the caller.
    await writeRead({ kind: 'main', chatId: 'c', seq: chatSeq(7) })
    await writeRead({ kind: 'main', chatId: 'c', seq: chatSeq(9) })
    await writeRead({ kind: 'main', chatId: 'c', seq: chatSeq(8) })
    expect(box.items()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(box.items()[0]).toMatchObject({ state: 'failed', payload: { seq: 9 } })
    expect(pull).toHaveBeenCalled()
    db.rpc.mockReset()
    db.rpc.mockResolvedValue({ data: [{ stream_id: 'main:c' }], error: null })
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('mark_stream_read', expect.objectContaining({ p_chat_id: 'c', p_seq: 9 }))
    expect(box.items()).toEqual([])
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rpc).toHaveBeenCalledOnce()
  })

  it('a read still not written on recovery waits for the next one (local is the fact)', async () => {
    vi.useFakeTimers()
    unbinds.push(bindBackendProbe(() => {}))
    db.rpc.mockResolvedValue(offline)
    await writeRead({ kind: 'thread', chatId: 'c', rootId: 'r', seq: chatSeq(4) })
    await vi.advanceTimersByTimeAsync(25_000)
    const attempts = db.rpc.mock.calls.length
    noteBackendAnswer(false); noteBackendAnswer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rpc).toHaveBeenCalledTimes(attempts + 1)
    expect(box.items()[0]).toMatchObject({ state: 'failed' })
    db.rpc.mockReset()
    db.rpc.mockResolvedValue({ data: [{ stream_id: 'thread:c:r' }], error: null })
    noteBackendAnswer(false); noteBackendAnswer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('mark_stream_read', expect.objectContaining({ p_chat_id: 'c', p_thread_root_id: 'r', p_seq: 4 }))
    expect(box.items()).toEqual([])
  })

  it('an account switch never writes the previous account\'s reads under the next one; they wait for their owner', async () => {
    vi.useFakeTimers()
    unbinds.push(bindBackendProbe(() => {}))
    db.rpc.mockResolvedValue(offline)
    await writeRead({ kind: 'main', chatId: 'shared-group', seq: chatSeq(12) })
    await vi.advanceTimersByTimeAsync(25_000)
    account.set('someone-else')
    await box.loaded()
    db.rpc.mockReset()
    db.rpc.mockResolvedValue({ data: [{ stream_id: 'main:shared-group' }], error: null })
    noteBackendAnswer(false); noteBackendAnswer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rpc).not.toHaveBeenCalled()
    account.set('me')
    await box.loaded()
    noteBackendAnswer(false); noteBackendAnswer(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('mark_stream_read', expect.objectContaining({ p_chat_id: 'shared-group', p_seq: 12 }))
  })
})
