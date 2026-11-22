/**
 * The one outbox (lib/outbox/core.ts): its contract, independent of any kind.
 * - durable before accepted; a write that died in flight is sent again after a restart (same id);
 * - lanes run in parallel, one write in flight per lane, first in first out; a held or failed write does not hold its lane;
 * - merge at enqueue; a confirmation of an older payload does not remove a newer one;
 * - one backoff (retries after 1 s, 4 s, 15 s), then failed; unreachable failures go again on recovery, refused ones wait;
 * - bound to the account it was enqueued under; another person stops the drain and aborts what is in flight.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOutbox, OutboxRejected, isServerRefusal, type OutboxAccount, type OutboxItem, type OutboxKind, type OutboxStorage } from '../../../../apps/desktop/src/lib/outbox/core'
import { noteBackendAnswer } from '@gugu/core/cloud/backendReachability'

function memoryStorage(): OutboxStorage & { rows: Map<string, OutboxItem> } {
  const rows = new Map<string, OutboxItem>()
  return {
    rows,
    list: async (accountId) => [...rows.values()].filter((row) => row.accountId === accountId).map((row) => structuredClone(row)),
    write: async (accountId, puts, removes) => {
      for (const item of puts) rows.set(`${accountId}/${item.id}`, structuredClone(item))
      for (const id of removes) rows.delete(`${accountId}/${id}`)
    },
  }
}

function account(initial: string | null): OutboxAccount & { set(id: string | null): void; signedOut(): void } {
  let id = initial
  let credential = initial
  const listeners = new Set<(id: string | null) => void>()
  return {
    current: () => id,
    credential: () => credential,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { id = next; credential = next; for (const listener of listeners) listener(next) },
    signedOut() { credential = null },
  }
}

type Deferred = { resolve: (value?: unknown) => void; reject: (error: unknown) => void; signal: AbortSignal; item: OutboxItem<{ text: string }> }

function kind(name = 'note', extra: Partial<OutboxKind<{ text: string; lane?: string }>> = {}) {
  const calls: Deferred[] = []
  const definition: OutboxKind<{ text: string; lane?: string }> = {
    name,
    lane: (payload) => payload.lane ?? 'a',
    send: (item, signal) => new Promise((resolve, reject) => { calls.push({ resolve, reject, signal, item }) }),
    ...extra,
  }
  return { definition, calls }
}

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); noteBackendAnswer(true) })

describe('outbox core', () => {
  it('accepts a write only once it is on disk, and sends again after a restart what died in flight', async () => {
    const storage = memoryStorage()
    const owner = account('u1')
    const first = createOutbox({ storage, account: owner, online: () => () => {} })
    const note = kind()
    first.register(note.definition)
    await first.loaded()
    const item = await first.enqueue('note', { text: 'hi' }, { id: 'm1' })
    expect(storage.rows.get('u1/m1')?.state).toBe('queued')
    await flush()
    expect(note.calls.map((call) => call.item.id)).toEqual(['m1'])
    expect(storage.rows.get('u1/m1')?.state).toBe('sending')
    first.dispose() // the window closed with the request in flight

    const second = createOutbox({ storage, account: account('u1'), online: () => () => {} })
    const again = kind()
    second.register(again.definition)
    await second.loaded()
    await flush()
    expect(again.calls.map((call) => call.item.id)).toEqual([item.id])
    again.calls[0]!.resolve()
    await flush()
    expect(storage.rows.size).toBe(0)
    expect(second.items()).toEqual([])
  })

  it('runs lanes in parallel and one write at a time in a lane, in order', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const note = kind()
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: '1', lane: 'a' })
    await box.enqueue('note', { text: '2', lane: 'a' })
    await box.enqueue('note', { text: '3', lane: 'b' })
    await flush()
    // A stuck write in lane a does not hold lane b.
    expect(note.calls.map((call) => call.item.payload.text)).toEqual(['1', '3'])
    note.calls[1]!.resolve()
    await flush()
    expect(note.calls.map((call) => call.item.payload.text)).toEqual(['1', '3'])
    note.calls[0]!.resolve()
    await flush()
    expect(note.calls.map((call) => call.item.payload.text)).toEqual(['1', '3', '2'])
  })

  it('retries after 1 s, 4 s and 15 s, holds its lane meanwhile, then fails and lets the lane go on', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const note = kind()
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: '1' }, { id: 'one' })
    await box.enqueue('note', { text: '2' }, { id: 'two' })
    await flush()
    const ids = () => note.calls.map((call) => call.item.id)
    for (const wait of [1_000, 4_000, 15_000]) {
      note.calls.at(-1)!.reject(new Error('down'))
      await flush()
      expect(box.get('one')?.state).toBe('waiting')
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(ids().filter((id) => id === 'one').length).toBe(note.calls.length) // nothing else went meanwhile
      const before = note.calls.length
      await vi.advanceTimersByTimeAsync(1)
      expect(note.calls.length).toBe(before + 1)
    }
    note.calls.at(-1)!.reject(new Error('down'))
    await flush()
    expect(box.get('one')).toMatchObject({ state: 'failed', attempts: 4, failure: { reason: 'unreachable', message: 'down' } })
    // The lane goes on behind a failed write.
    expect(ids()).toEqual(['one', 'one', 'one', 'one', 'two'])
  })

  it('sends unreachable failures again when the backend recovers, never refused ones', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const note = kind('note', { timeoutMs: null })
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: 'x', lane: 'a' }, { id: 'lost' })
    await box.enqueue('note', { text: 'y', lane: 'b' }, { id: 'refused' })
    await flush()
    note.calls.find((call) => call.item.id === 'refused')!.reject(new OutboxRejected('no'))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await flush()
      note.calls.filter((row) => row.item.id === 'lost').at(-1)!.reject(new Error('offline'))
      await vi.advanceTimersByTimeAsync(16_000)
    }
    expect(box.get('lost')).toMatchObject({ state: 'failed', failure: { reason: 'unreachable' } })
    expect(box.get('refused')).toMatchObject({ state: 'failed', failure: { reason: 'rejected' } })
    const before = note.calls.length
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await flush()
    expect(note.calls.slice(before).map((call) => call.item.id)).toEqual(['lost'])
    // Sent again in the background: it keeps showing failed until confirmed.
    expect(box.get('lost')?.state).toBe('failed')
    note.calls.at(-1)!.resolve()
    await flush()
    expect(box.get('lost')).toBeUndefined()
  })

  it('sends an unreachable failure again on the next start, never a refused one', async () => {
    const storage = memoryStorage()
    const first = createOutbox({ storage, account: account('u1'), online: () => () => {} })
    const note = kind('note', { timeoutMs: null })
    first.register(note.definition)
    await first.loaded()
    await first.enqueue('note', { text: 'x', lane: 'a' }, { id: 'lost' })
    await first.enqueue('note', { text: 'y', lane: 'b' }, { id: 'refused' })
    await flush()
    note.calls.find((call) => call.item.id === 'refused')!.reject(new OutboxRejected('no'))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await flush()
      note.calls.filter((row) => row.item.id === 'lost').at(-1)!.reject(new Error('offline'))
      await vi.advanceTimersByTimeAsync(16_000)
    }
    expect(storage.rows.get('u1/lost')).toMatchObject({ state: 'failed', failure: { reason: 'unreachable' } })
    first.dispose()

    const second = createOutbox({ storage, account: account('u1'), online: () => () => {} })
    const again = kind('note', { timeoutMs: null })
    second.register(again.definition)
    await second.loaded()
    await flush()
    expect(again.calls.map((call) => call.item.id)).toEqual(['lost'])
    expect(second.get('lost')?.state).toBe('failed') // shown failed until confirmed
    again.calls[0]!.resolve()
    await flush()
    expect(second.get('lost')).toBeUndefined()
    expect(second.get('refused')).toMatchObject({ state: 'failed', failure: { reason: 'rejected' } })
  })

  it('fails a write the server refused once, never sends it again on recovery or restart; a transient failure waits (#3578)', async () => {
    const storage = memoryStorage()
    const first = createOutbox({ storage, account: account('u1'), online: () => () => {} })
    const note = kind('note', { timeoutMs: null })
    first.register(note.definition)
    await first.loaded()
    await first.enqueue('note', { text: 'dm', lane: 'a' }, { id: 'dm' })
    await first.enqueue('note', { text: 'busy', lane: 'b' }, { id: 'lock' })
    await flush()
    // As the chat writer throws send_message_with_overlays' dm_friendship_required: its words, the SQLSTATE in `cause`.
    note.calls.find((call) => call.item.id === 'dm')!.reject(new Error('dm_friendship_required', { cause: { code: '42501', message: 'dm_friendship_required' } }))
    note.calls.find((call) => call.item.id === 'lock')!.reject(Object.assign(new Error('could not obtain lock'), { code: '55P03' }))
    await flush()
    expect(storage.rows.get('u1/dm')).toMatchObject({ state: 'failed', attempts: 1, failure: { reason: 'rejected', message: 'dm_friendship_required' } })
    expect(storage.rows.get('u1/lock')).toMatchObject({ state: 'waiting', failure: { reason: 'unreachable' } })
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await flush()
    expect(note.calls.filter((call) => call.item.id === 'dm')).toHaveLength(1)
    first.dispose()

    const second = createOutbox({ storage, account: account('u1'), online: () => () => {} })
    const again = kind('note', { timeoutMs: null })
    second.register(again.definition)
    await second.loaded()
    await flush()
    expect(again.calls.map((call) => call.item.id)).not.toContain('dm')
    expect(second.get('dm')).toMatchObject({ state: 'failed', failure: { reason: 'rejected' } })
  })

  it('reads a refusal from the SQLSTATE or HTTP status on the error or its cause (isServerRefusal)', () => {
    for (const refused of [{ code: '42501' }, { code: '23505' }, { code: '55000' }, new Error('wrapped', { cause: { code: '22023' } }), { status: 403 }, { status: 409 }]) {
      expect(isServerRefusal(refused)).toBe(true)
    }
    // Transient classes, PostgREST's own codes (PGRST202: RPC not in its schema cache yet), credentials, 5xx, no answer.
    for (const transient of [{ code: '08006' }, { code: '40001' }, { code: '55P03' }, { code: '57014' }, { code: 'XX000' }, { code: 'PGRST202' }, { status: 401 }, { status: 429 }, { status: 502 }, new Error('offline')]) {
      expect(isServerRefusal(transient)).toBe(false)
    }
  })

  it('merges at enqueue and confirms the newest payload, not the one in flight', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const read = kind('read', { merge: (previous, next) => Number(previous.text) > Number(next.text) ? previous : next })
    box.register(read.definition)
    await box.loaded()
    await box.enqueue('read', { text: '5' }, { id: 'read:main:c' })
    await flush()
    await box.enqueue('read', { text: '9' }, { id: 'read:main:c' })
    await box.enqueue('read', { text: '7' }, { id: 'read:main:c' })
    expect(box.items()).toHaveLength(1)
    read.calls[0]!.resolve()
    await flush()
    expect(read.calls.map((call) => call.item.payload.text)).toEqual(['5', '9'])
    read.calls[1]!.resolve()
    await flush()
    expect(box.items()).toEqual([])
  })

  it('merges enqueues of one id that overlap, as a seen-read fires one per row it reports', async () => {
    const storage = memoryStorage()
    const box = createOutbox({ storage, account: account('u1'), online: () => () => {} })
    const read = kind('read', { merge: (previous, next) => Number(previous.text) > Number(next.text) ? previous : next })
    box.register(read.definition)
    await box.loaded()
    // Not awaited one by one: each is still on its way to disk when the next arrives.
    await Promise.all(['334', '335', '336'].map((text) => box.enqueue('read', { text }, { id: 'read:main:c' })))
    await flush()
    read.calls[0]!.resolve()
    await flush()
    expect(read.calls.map((call) => call.item.payload.text).at(-1)).toBe('336')
    read.calls.at(-1)!.resolve()
    await flush()
    expect(box.items()).toEqual([])
    expect(storage.rows.size).toBe(0)
  })

  it('waits for a dependency, and fails its dependents when it is discarded', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const note = kind()
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: 'file', lane: 'a' }, { id: 'file' })
    await box.enqueue('note', { text: 'caption', lane: 'b' }, { id: 'caption', dependsOn: ['file'] })
    await flush()
    expect(note.calls.map((call) => call.item.id)).toEqual(['file'])
    await box.discard('file')
    await flush()
    expect(note.calls[0]!.signal.aborted).toBe(true)
    expect(box.get('caption')).toMatchObject({ state: 'failed', failure: { reason: 'dependency' } })
    await expect(box.settled('caption')).rejects.toThrow()
  })

  it('keeps held writes out of the lane until released, in the order the person gave them', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const note = kind()
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: 'q1' }, { id: 'q1', hold: true })
    await box.enqueue('note', { text: 'q2' }, { id: 'q2', hold: true })
    await box.enqueue('note', { text: 'now' }, { id: 'now' })
    await flush()
    expect(note.calls.map((call) => call.item.id)).toEqual(['now'])
    await box.reorder(['q2', 'q1'])
    expect(box.items().filter((item) => item.state === 'held').map((item) => item.id)).toEqual(['q2', 'q1'])
    await box.release('q2', { text: 'q2!' })
    note.calls[0]!.resolve()
    await flush()
    expect(note.calls.map((call) => call.item.payload.text)).toEqual(['now', 'q2!'])
  })

  it('drains only for the account the writes were enqueued under, and stops for another person', async () => {
    const storage = memoryStorage()
    const owner = account('u1')
    const box = createOutbox({ storage, account: owner, online: () => () => {} })
    const note = kind()
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: 'mine' }, { id: 'm' })
    await flush()
    owner.set('u2')
    await box.loaded()
    expect(note.calls[0]!.signal.aborted).toBe(true)
    expect(box.items()).toEqual([])
    expect(storage.rows.get('u1/m')).toBeDefined() // still on disk for its account
    await box.enqueue('note', { text: 'theirs' }, { id: 't' })
    await flush()
    expect(note.calls.map((call) => call.item.id)).toEqual(['m', 't'])
    // Credentials gone (session absent): the drain pauses instead of sending as nobody.
    owner.signedOut()
    await box.enqueue('note', { text: 'later', lane: 'z' }, { id: 'z' })
    await flush()
    expect(note.calls.map((call) => call.item.id)).toEqual(['m', 't'])
  })

  it('aborts an attempt at its deadline and tries again', async () => {
    const box = createOutbox({ storage: memoryStorage(), account: account('u1'), online: () => () => {} })
    const note = kind('note', { timeoutMs: 20_000 })
    box.register(note.definition)
    await box.loaded()
    await box.enqueue('note', { text: 'slow' }, { id: 's' })
    await flush()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(note.calls[0]!.signal.aborted).toBe(true)
    expect(box.get('s')).toMatchObject({ state: 'waiting', attempts: 1 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(note.calls).toHaveLength(2)
  })
})
