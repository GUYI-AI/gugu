import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'
import { chatHarness, memoryStorage } from './chatOutboxHarness'
import { noteBackendAnswer } from '@gugu/core/cloud/backendReachability'

function record(id: string, chatId = 'A', dependsOn?: string): OutboxRecord {
  return { clientMessageId: id, chatId, senderUserId: 'user-1', dependsOn,
    payload: { content: id, contentType: 'text', toUserIds: null, replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
    state: 'pending', attempts: 0, lastError: null, enqueuedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
}
function fixture(storage = memoryStorage(), ack?: (record: OutboxRecord) => Promise<void>) {
  const send = vi.fn(async (_row: OutboxRecord): Promise<unknown> => undefined)
  const h = chatHarness((row) => send(row), ack ? { ack: async (row) => { await ack(row) } } : {}, { storage })
  const saved = { get: (id: string) => h.row(id), has: (id: string) => !!h.row(id) }
  return { ...h, saved, send, sent: () => send.mock.calls.map(([r]) => r.clientMessageId) }
}
// Long enough for every backoff (1 s, 4 s) to run out.
async function flush() { await vi.advanceTimersByTimeAsync(25_000) }
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); noteBackendAnswer(true) })

describe('durable source dependencies in the chat outbox', () => {
  // Owner 11-15: a file is declared (hashed, planned) before its message commits and its bytes go up after it, so a
  // file keeps its place: text sent after an image never reaches the conversation before it. Other chats do not wait.
  it('a file being declared keeps its place in its lane, and multiple forwards wait for the same source', async () => {
    const f = fixture()
    await f.outbox.stageUpload({ ...record('image'), operation: { kind: 'upload' } })
    await f.outbox.enqueue(record('forward-B', 'B', 'image'))
    await f.outbox.enqueue(record('forward-C', 'C', 'image'))
    await f.outbox.enqueue(record('text', 'A'))
    await f.outbox.enqueue(record('elsewhere', 'D'))
    await flush()
    expect(f.sent()).toEqual(['elsewhere'])
    await f.outbox.commitUpload({ ...record('image'), operation: { kind: 'attachment', commit: { staging_key: 'staging/image', message_id: 'image', chat_id: 'A', sender_user_id: 'user-1', file_name: 'photo.png' } } })
    await flush()
    const sent = f.sent()
    expect(sent.slice(0, 2)).toEqual(['elsewhere', 'image'])
    expect(sent.indexOf('text')).toBeGreaterThan(sent.indexOf('image'))
    expect(new Set(sent)).toEqual(new Set(['elsewhere', 'image', 'text', 'forward-B', 'forward-C']))
  })
  it('an uploading source and a dependent topic in the same lane cannot deadlock', async () => {
    const f = fixture()
    await f.outbox.stageUpload({ ...record('image'), operation: { kind: 'upload' } })
    await f.outbox.enqueue(record('topic', 'A', 'image'))
    await flush()
    expect(f.send).not.toHaveBeenCalled()
    await f.outbox.commitUpload(record('image'))
    await flush()
    expect(f.sent()).toEqual(['image', 'topic'])
  })
  it('source failure fails forwarding (retryable, not "discarded") and releases later destination text', async () => {
    const f = fixture()
    await f.outbox.stageUpload({ ...record('image'), operation: { kind: 'upload' } })
    await f.outbox.enqueue(record('forward', 'B', 'image'))
    await f.outbox.enqueue(record('later', 'B'))
    await f.outbox.failUpload('image', new Error('upload refused'))
    await flush()
    expect(f.saved.get('forward')).toMatchObject({ state: 'failed', attempts: 0 })
    expect(f.saved.get('forward')?.dependencyDiscarded).toBeUndefined()
    expect(f.saved.get('forward')?.lastError).not.toContain('upload refused')
    expect(f.sent()).toEqual(['later'])
  })
  it('retrying forwarding waits while the source itself retries, then delivers once', async () => {
    const f = fixture()
    let rejectSource = true
    let finish!: () => void
    f.send.mockImplementation(async r => {
      if (r.clientMessageId !== 'source') return
      if (rejectSource) throw new Error('offline')
      await new Promise<void>(resolve => { finish = resolve })
    })
    await f.outbox.enqueue(record('source'))
    await flush()
    await f.outbox.enqueue(record('forward', 'B', 'source'))
    await flush()
    expect(f.saved.get('forward')?.state).toBe('failed')
    rejectSource = false
    await f.outbox.retry('source')
    await f.outbox.retry('forward')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.saved.get('forward')?.state).toBe('pending')
    finish()
    await flush()
    expect(f.send.mock.calls.filter(([r]) => r.clientMessageId === 'forward')).toHaveLength(1)
  })
  it('discard is durable: a restored dependent cannot be retried as if its source arrived', async () => {
    const storage = memoryStorage()
    const f = fixture(storage)
    await f.outbox.stageUpload({ ...record('source'), operation: { kind: 'upload' } })
    await f.outbox.enqueue(record('forward', 'B', 'source'))
    await f.outbox.discard('source')
    await flush()
    expect(f.saved.get('forward')).toMatchObject({ state: 'failed', dependencyDiscarded: true })
    f.box.dispose()
    const restored = fixture(storage)
    await restored.outbox.restore()
    noteBackendAnswer(false)
    noteBackendAnswer(true)
    await restored.outbox.retry('forward')
    await flush()
    expect(restored.send).not.toHaveBeenCalled()
  })
  it('reload fails a byte-less upload and its dependent, without blocking the destination', async () => {
    const storage = memoryStorage()
    const first = fixture(storage)
    first.send.mockImplementation(() => new Promise(() => {}))
    await first.outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
    await first.outbox.enqueue(record('forward', 'B', 'upload'))
    await first.outbox.enqueue(record('text', 'B'))
    first.box.dispose()
    const f = fixture(storage)
    await f.outbox.restore()
    await flush()
    expect(f.saved.get('upload')?.state).toBe('failed')
    expect(f.saved.get('forward')?.state).toBe('failed')
    expect(f.sent()).toEqual(['text'])
  })
})

it('discarding a waiting forward immediately releases its destination lane', async () => {
  const f = fixture()
  await f.outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await f.outbox.enqueue(record('forward', 'B', 'upload'))
  await f.outbox.enqueue(record('text', 'B'))
  await flush()
  await f.outbox.discard('forward')
  await flush()
  expect(f.sent()).toEqual(['text'])
})
it('a same-lane upload failure releases its dependent and the later text', async () => {
  const f = fixture()
  await f.outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await f.outbox.enqueue(record('topic', 'A', 'upload'))
  await f.outbox.enqueue(record('text', 'A'))
  await flush()
  await f.outbox.failUpload('upload', new Error('upload refused'))
  await flush()
  expect(f.saved.get('topic')?.state).toBe('failed')
  expect(f.sent()).toEqual(['text'])
})

it('discard during byte upload cannot be undone by its eventual ready commit', async () => {
  const f = fixture()
  await f.outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await f.outbox.discard('upload')
  expect(await f.outbox.commitUpload(record('upload'))).toBe(false)
  await flush()
  expect(f.saved.has('upload')).toBe(false)
  expect(f.send).not.toHaveBeenCalled()
})

it('discard wins over upload completion while dependent failure is being persisted', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const storage = memoryStorage()
  storage.beforeWrite = async puts => { if (puts.some(item => item.id === 'forward' && item.state === 'failed')) await gate }
  const f = fixture(storage)
  await f.outbox.stageUpload({ ...record('upload'), operation: { kind: 'upload' } })
  await f.outbox.enqueue(record('forward', 'B', 'upload'))
  await flush()
  const discard = f.outbox.discard('upload')
  expect(await f.outbox.commitUpload(record('upload'))).toBe(false)
  release()
  await discard
  await flush()
  expect(f.send).not.toHaveBeenCalled()
})

describe('creation order prevents lane/dependency cycles', () => {
  it('commits an earlier upload before a cross-lane forwarding chain waiting back on it', async () => {
    const f = fixture()
    await f.outbox.stageUpload({ ...record('u', 'A'), operation: { kind: 'upload' } })
    await f.outbox.enqueue(record('f_b', 'B', 'u'))
    await f.outbox.enqueue(record('b2', 'B'))
    await f.outbox.enqueue(record('f_a', 'A', 'b2'))
    await flush()
    await f.outbox.commitUpload(record('u', 'A'))
    await flush()
    expect(f.sent()).toEqual(['u', 'f_b', 'b2', 'f_a'])
    expect(f.records()).toEqual([])
  })
  it('does not deliver a dependent while discard persistence is suspended', async () => {
    let releaseSave!: () => void, releaseSend!: () => void
    const saving = new Promise<void>(resolve => { releaseSave = resolve })
    const sending = new Promise<void>(resolve => { releaseSend = resolve })
    const storage = memoryStorage()
    storage.beforeWrite = async puts => { if (puts.some(item => item.id === 'dep' && item.state === 'failed')) await saving }
    const f = fixture(storage)
    f.send.mockImplementation(async row => { if (row.clientMessageId === 't0' || row.clientMessageId === 'source') await sending })
    await f.outbox.enqueue(record('source', 'S'))
    await f.outbox.enqueue(record('t0', 'T'))
    await f.outbox.enqueue(record('dep', 'T', 'source'))
    await vi.advanceTimersByTimeAsync(0)
    const discarding = f.outbox.discard('source')
    releaseSend()
    await vi.advanceTimersByTimeAsync(0)
    releaseSave()
    await discarding
    await flush()
    expect(f.sent()).not.toContain('dep')
    expect(f.saved.get('dep')).toMatchObject({ state: 'failed', dependencyDiscarded: true })
  })
  it('terminates seeded interleavings of lanes, uploads, forwarding, failure, discard and restart', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      let randomState = seed
      const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState }
      const ack = async (row: OutboxRecord) => { if (row.clientMessageId === 'ack-final') throw new Error('ack failed') }
      const storage = memoryStorage()
      let f = fixture(storage, ack)
      const configure = () => f.send.mockImplementation(async row => { if (Number(row.clientMessageId.slice(1)) % 7 === 0) throw new Error('offline') })
      configure()
      const ids: string[] = []
      for (let n = 0; n < 24; n++) {
        const id = `m${n}`, lane = String(random() % 3)
        const dependsOn = ids.length && random() % 3 === 0 ? ids[random() % ids.length] : undefined
        const row = record(id, lane, dependsOn)
        if (random() % 3 === 0) await f.outbox.stageUpload({ ...row, operation: { kind: 'upload' } })
        else await f.outbox.enqueue(row)
        ids.push(id)
        if (random() % 4 === 0) await f.outbox.discard(ids[random() % ids.length]!)
        if (random() % 5 === 0) {
          const uploading = f.records().find(r => r.state === 'uploading')
          if (uploading) await f.outbox.commitUpload({ ...uploading, operation: undefined })
        }
        await flush()
        if (n === 12) { f.box.dispose(); f = fixture(storage, ack); configure(); await f.outbox.restore(); await flush() }
      }
      for (const row of f.records()) if (row.state === 'uploading') await f.outbox.commitUpload({ ...row, operation: undefined })
      await vi.advanceTimersByTimeAsync(120_000) // every lane's backoff runs out, however the rows queued behind each other
      expect(f.records().filter(row => row.state !== 'failed'), `seed ${seed}`).toEqual([])
      // No subsequent enqueue may conceal a missing failure-settlement kick.
      await f.outbox.stageUpload({ ...record('last-upload', 'A'), operation: { kind: 'upload' } })
      await f.outbox.enqueue(record('last-forward', 'B', 'last-upload'))
      await f.outbox.enqueue(record('last-chain', 'C', 'last-forward'))
      await flush()
      await f.outbox.failUpload('last-upload', new Error('offline'))
      await flush()
      expect(f.records().filter(row => row.state !== 'failed'), `upload-last seed ${seed}`).toEqual([])
      await f.outbox.enqueue(record('ack-final', 'A'))
      await f.outbox.enqueue(record('ack-forward', 'B', 'ack-final'))
      await f.outbox.enqueue(record('ack-chain', 'C', 'ack-forward'))
      await flush()
      expect(f.records().filter(row => row.state !== 'failed'), `ack-last seed ${seed}`).toEqual([])
      f.box.dispose()
    }
  })
})

it('propagates the last upload failure through multiple lanes without another external kick', async () => {
  const f = fixture()
  await f.outbox.stageUpload({ ...record('s', 'A'), operation: { kind: 'upload' } })
  await f.outbox.enqueue(record('f1', 'B', 's'))
  await f.outbox.enqueue(record('f2', 'C', 'f1'))
  await f.outbox.enqueue(record('later', 'C'))
  await flush()
  await f.outbox.failUpload('s', new Error('refused'))
  await flush()
  expect(f.sent()).toEqual(['later'])
  expect(f.records().map(row => row.state)).toEqual(['failed', 'failed', 'failed'])
})
it('propagates the last durable ack failure to a dependent without another external kick', async () => {
  const f = fixture(memoryStorage(), async () => { throw new Error('local write failed') })
  await f.outbox.enqueue(record('s', 'A'))
  await f.outbox.enqueue(record('f', 'B', 's'))
  await flush()
  // The ack failure is a failed attempt: the same id is sent again (idempotent), then the row fails.
  expect(f.sent()).toEqual(['s', 's', 's', 's'])
  expect(f.records().map(row => row.state)).toEqual(['failed', 'failed'])
})
it('a native publication goes in its lane like any send, and what depends on it follows', async () => {
  const f = fixture()
  await f.outbox.stageUpload({ ...record('native'), operation: { kind: 'upload' } })
  await f.outbox.commitUpload({ ...record('native'), operation: { kind: 'nativeAttachment', commit: { message_id: 'native', chat_id: 'A', sender_user_id: 'user-1', file_name: 'large.txt', to_user_ids: [] } } })
  await f.outbox.enqueue(record('text'))
  await f.outbox.enqueue(record('forward', 'B', 'native'))
  await flush()
  expect(f.sent()).toEqual(['native', 'text', 'forward'])
  expect(f.records()).toEqual([])
})
