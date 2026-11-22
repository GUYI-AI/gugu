/**
 * Session inputs as the outbox kind `sessionInput` (lib/outbox/kinds/sessionInput.ts), driven through the same API the
 * composer and the transcript use, over a real outbox. Only the host transport and the disk are the test's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { SessionInputAdmissionError } from '@gugu/core/shared/sessionInputAdmission'
import { buildSessionDirectEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { SessionInputFailureError, sessionInputBubbles, withSessionInputDeadline, type HostPendingRow, type SessionInput, type SessionInputFailure } from '../../../../apps/desktop/src/lib/sessionInput'
import { changeRejectedSessionInput, enqueueSessionInput, retrySessionInput, retrySessionInputs, state } from '../../../../apps/desktop/src/lib/outbox/kinds/sessionInput'
import { openOutboxStorage } from '../../../../apps/desktop/src/lib/outbox/storage'
import { importLegacyWrites } from '../../../../apps/desktop/src/lib/outbox/legacy'
import { installSessionInputOutbox, memoryOutboxStorage, settle, type InstalledSessionInputs } from '../../../helpers/sessionInputOutbox'

// Only session inputs are under test; the App-notice kind reaches the cloud client.
vi.mock('../../../../apps/desktop/src/lib/outbox/kinds/assistantNotice', () => ({ enqueueAssistantNotice: vi.fn() }))

let installed: InstalledSessionInputs | undefined
const install = (...args: Parameters<typeof installSessionInputOutbox>) => (installed = installSessionInputOutbox(...args))
afterEach(() => { installed?.dispose(); installed = undefined; vi.useRealTimers() })
const rows = () => state().rows

describe('native session input persistence', () => {
  it('honors an explicit custody acceptance even when a later operation reports an error', async () => {
    let attempts = 0
    install({ send: async () => { attempts++; throw new SessionInputAdmissionError('accepted, but notification failed', 'accepted', 'same-code') } })
    await enqueueSessionInput({ deviceId: null, sessionId: 'agent', text: 'already in host custody' })
    await settle()
    retrySessionInputs(); await settle()
    expect(attempts).toBe(1)
    expect(rows()).toEqual([])
  })

  it.each([undefined, null])('keeps an untyped %s rejection in automatic recovery rather than treating it as acceptance or refusal', async error => {
    install({ send: async () => { throw error } })
    const input = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'retain this input' })
    await settle()
    expect(rows()).toEqual([expect.objectContaining({ id: input.id, failure: expect.objectContaining({ code: 'send-failed' }) })])
    expect(rows()[0]!.admission).toBeUndefined()
    expect(sessionInputBubbles(rows(), [], null)[0]!.state).toBe('waiting')
  })

  it('hands definitive refusals to the person across restarts, with independent single-input recovery', async () => {
    const storage = memoryOutboxStorage()
    const attempts: [string, string][] = []
    let refuse = true
    const send = async (input: SessionInput) => {
      attempts.push([input.id, input.text])
      if (refuse) throw new SessionInputAdmissionError('This input is not allowed', 'rejected', 'a-future-host-code')
    }
    install({ send, storage })
    const a = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'original' })
    const b = await enqueueSessionInput({ deviceId: 'host', sessionId: 'other', text: 'keep this too' })
    await settle()
    expect(rows().map(input => input.admission)).toEqual(['rejected', 'rejected'])
    installed!.dispose()
    install({ send, storage }) // restart: a refusal stays the person's
    await installed!.outbox.loaded(); await settle()
    retrySessionInputs(); await settle()
    expect(attempts).toHaveLength(2)
    expect(sessionInputBubbles(rows(), [], null).map(bubble => bubble.state)).toEqual(['failed', 'failed'])
    await changeRejectedSessionInput(a.id, { kind: 'edit', text: 'edited' })
    await settle()
    expect(attempts).toHaveLength(2)
    refuse = false
    await retrySessionInput(a.id)
    await settle()
    expect(attempts).toEqual([[a.id, 'original'], [b.id, 'keep this too'], [a.id, 'edited']])
    expect(rows().map(input => input.id)).toEqual([b.id])
    await changeRejectedSessionInput(b.id, { kind: 'discard' })
    expect(rows()).toEqual([])
  })

  it.each(['uncertain', undefined] as const)('automatically recovers a %s result with the same id after its backoff, and keeps it out of manual edits', async admission => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const attempts: string[] = []
    install({ send: async input => {
      attempts.push(input.id)
      if (attempts.length === 1) throw Object.assign(new Error('session not found'), { code: 'session_not_found', ...(admission ? { admission } : {}) })
    } })
    const input = await enqueueSessionInput({ deviceId: null, sessionId: 'agent', text: 'retry the original' })
    await settle()
    expect(sessionInputBubbles(rows(), [], null)[0]!.state).toBe('waiting')
    await expect(changeRejectedSessionInput(input.id, { kind: 'edit', text: 'unsafe change' })).rejects.toThrow('manual decision')
    await expect(changeRejectedSessionInput(input.id, { kind: 'discard' })).rejects.toThrow('manual decision')
    await vi.advanceTimersByTimeAsync(1_000); await settle()
    expect(attempts).toEqual([input.id, input.id])
    expect(rows()).toEqual([])
  })

  it('shows an input undelivered (red) after three unanswered retries (1 s, 4 s, 15 s), then sends it again on recovery with the same id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let online = false
    const sent: string[] = []
    install({ send: async input => { sent.push(input.id); if (!online) throw new SessionInputFailureError({ code: 'host-offline' }) } })
    const input = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'retry me' })
    await settle()
    expect(rows()[0]).toMatchObject({ failure: { code: 'host-offline' } })
    expect(sessionInputBubbles(rows(), [], null)[0]!.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000); await settle()
    await vi.advanceTimersByTimeAsync(4_000); await settle()
    expect(sent).toEqual([input.id, input.id, input.id])
    expect(sessionInputBubbles(rows(), [], null)[0]!.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(15_000); await settle()
    expect(sent).toEqual([input.id, input.id, input.id, input.id])
    expect(rows()[0]).toMatchObject({ undelivered: true, failure: { code: 'host-offline' } })
    expect(rows()[0]!.admission).toBeUndefined()
    expect(sessionInputBubbles(rows(), [], null)).toEqual([{ id: input.id, text: 'retry me', state: 'undelivered', failure: { code: 'host-offline' } }])
    // Nothing polls: no timer sends it again.
    await vi.advanceTimersByTimeAsync(120_000); await settle()
    expect(sent).toHaveLength(4)
    online = true
    await retrySessionInputs() // the host came back (OutboxHost kicks on device and session-directory changes)
    await settle()
    expect(sent).toEqual([input.id, input.id, input.id, input.id, input.id])
    expect(rows()).toEqual([])
  })

  it('a manual retry of an undelivered input starts again with a fresh attempt budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    let calls = 0
    install({ send: async () => { calls++; throw new Error('still offline') } })
    const input = await enqueueSessionInput({ deviceId: null, sessionId: 'agent', text: 'retry me' })
    await settle(); await vi.advanceTimersByTimeAsync(20_000); await settle()
    expect(rows()[0]).toMatchObject({ undelivered: true })
    await retrySessionInput(input.id)
    await settle()
    expect(calls).toBe(5)
    expect(rows()[0]).toMatchObject({ failure: { code: 'send-failed', message: 'still offline' } })
    expect(rows()[0]!.undelivered).toBeUndefined()
  })

  it.each<SessionInputFailure>([
    { code: 'host-offline' }, { code: 'host-not-ready' }, { code: 'phone-unconfirmed' },
    { code: 'no-acknowledgement' }, { code: 'send-failed', message: 'SSH transport closed' },
  ])('retains automatic custody after $code until acceptance', async failure => {
    const delivered: string[] = []
    let fail = true
    install({ send: async input => {
      if (fail) { fail = false; throw failure.code === 'send-failed' ? new Error(failure.message) : new SessionInputFailureError(failure) }
      delivered.push(input.id)
    } })
    const input = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'recover automatically' })
    await settle()
    expect(sessionInputBubbles(rows(), [], null)).toEqual([{ id: input.id, text: input.text, state: 'waiting', failure }])
    await retrySessionInputs(); await settle()
    expect(delivered).toEqual([input.id])
    expect(rows()).toEqual([])
  })

  it('preserves runtime attachment references and does not block the following input', async () => {
    const received: SessionInput[] = []
    install({ send: async input => { received.push(input) } })
    const attachments = [{ type: 'attachment', id: 'old-image', mimeType: 'image/png' }] as unknown as SessionInput['attachments']
    await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'read the image', attachments })
    await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'following input' })
    await settle()
    expect(received.map(input => input.text)).toEqual(['read the image', 'following input'])
    expect(received[0]!.attachments).toEqual(attachments)
    expect(rows()).toEqual([])
  })

  it('survives an offline restart and delivers in order automatically with the same identities', async () => {
    const factory = new IDBFactory()
    const storage = openOutboxStorage(factory)
    let online = false
    const received: SessionInput[] = []
    const send = async (input: SessionInput) => { if (!online) throw new Error('offline'); received.push(input) }
    install({ send, storage })
    const a = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'first' })
    const b = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'second' })
    await settle()
    expect(rows()).toHaveLength(2)
    installed!.dispose()
    online = true
    install({ send, storage: openOutboxStorage(factory) })
    await installed!.outbox.loaded(); await settle()
    await retrySessionInputs(); await settle()
    expect(received.map(input => [input.id, input.text])).toEqual([[a.id, 'first'], [b.id, 'second']])
    expect(rows()).toEqual([])
  })

  it('replays the same id after an acknowledgement is lost, without a second native turn', async () => {
    const hostRows = new Map<string, string>()
    let lost = true
    install({ send: async input => { hostRows.set(input.id, input.text); if (lost) throw new Error('reply lost') } })
    const input = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'raw user input' })
    await settle()
    lost = false
    await retrySessionInputs(); await settle()
    expect([...hostRows]).toEqual([[input.id, 'raw user input']])
    expect(rows()).toEqual([])
  })

  it('a host that hangs holds only its own sessions: another session goes at once', async () => {
    const sent: string[] = []
    install({ send: input => input.deviceId === 'stuck-host' ? new Promise<void>(() => {}) : (sent.push(input.text), Promise.resolve()) })
    await enqueueSessionInput({ deviceId: 'stuck-host', sessionId: 'a', text: 'to the hung host' })
    await enqueueSessionInput({ deviceId: 'stuck-host', sessionId: 'a', text: 'behind it, same session' })
    await enqueueSessionInput({ deviceId: 'other-host', sessionId: 'b', text: 'another session' })
    await enqueueSessionInput({ deviceId: 'stuck-host', sessionId: 'c', text: 'another session on the hung host' })
    await settle()
    expect(sent).toEqual(['another session'])
    expect(rows().map(row => row.text)).toEqual(['to the hung host', 'behind it, same session', 'another session on the hung host'])
  })

  it('aborts an attempt after 30 s without an answer and shows it waiting for acknowledgement', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const calls: string[] = []
    install({ send: input => { calls.push(input.id); return new Promise<void>(() => {}) } })
    const input = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'silent host' })
    await settle()
    await vi.advanceTimersByTimeAsync(29_999); await settle()
    expect(rows()[0]!.failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1); await settle()
    expect(rows()[0]).toMatchObject({ id: input.id, failure: { code: 'no-acknowledgement' } })
    await vi.advanceTimersByTimeAsync(1_000); await settle()
    expect(calls).toEqual([input.id, input.id])
  })

  it('never drains another account after logout, and keeps the first account\'s rows', async () => {
    const storage = memoryOutboxStorage()
    const sent: string[] = []
    install({ send: async input => { sent.push(input.accountId) ; throw new Error('offline') }, storage })
    await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'private' })
    await settle()
    installed!.setAccount('other')
    await installed!.outbox.loaded(); await settle()
    await retrySessionInputs(); await settle()
    expect(rows()).toEqual([])
    expect(sent.every(account => account === 'owner')).toBe(true)
    expect([...storage.rows.values()].map(row => row.accountId)).toEqual(['owner'])
  })
})

it('keeps an image and its caption in one durable request across a reopened database', async () => {
  const factory = new IDBFactory()
  install({ send: async () => { throw new Error('offline') }, storage: openOutboxStorage(factory) })
  const files = [{ itemId: 'image-item', version: 1, name: 'image.png', mimeType: 'image/png', sizeBytes: 4 }]
  const input = await enqueueSessionInput({ deviceId: 'host', sessionId: 'agent', text: 'look at this', files })
  await settle()
  installed!.dispose()
  const received: SessionInput[] = []
  install({ send: async input => { received.push(input) }, storage: openOutboxStorage(factory) })
  await installed!.outbox.loaded(); await settle()
  await retrySessionInputs(); await settle()
  expect(received).toEqual([expect.objectContaining({ id: input.id, text: 'look at this', files })])
  expect(rows()).toEqual([])
})

it('stores a missing acknowledgement as its failure code and keeps a host refusal in the host words', async () => {
  let send = (_input: SessionInput) => withSessionInputDeadline(new Promise<void>(() => {}), 1)
  install({ send: input => send(input) })
  const input = await enqueueSessionInput({ deviceId: null, sessionId: 'agent', text: 'silent host' })
  await expect.poll(() => rows()[0]?.failure).toEqual({ code: 'no-acknowledgement' })
  send = async () => { throw new SessionInputAdmissionError('Provider login expired', 'rejected') }
  await retrySessionInputs()
  await expect.poll(() => rows()[0]).toMatchObject({ id: input.id, admission: 'rejected', failure: { code: 'send-failed', message: 'Provider login expired' } })
})

it('moves the previous build\'s session inputs into the outbox once, keeping ids, queue and refusals', async () => {
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('gugu.session-input-outbox.v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('inputs', { keyPath: ['accountId', 'id'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const old: SessionInput[] = [
    { id: 'plain', accountId: 'owner', deviceId: 'host', sessionId: 's', text: 'plain', createdAt: 1 },
    { id: 'held', accountId: 'owner', deviceId: 'host', sessionId: 's', text: 'held', createdAt: 2, queued: true, sendQueue: { order: 2, afterInputId: 'plain' } },
    { id: 'refused', accountId: 'owner', deviceId: 'host', sessionId: 'r', text: 'refused', createdAt: 3, admission: 'rejected', failure: { code: 'send-failed', message: 'no' } },
    { id: 'someone-else', accountId: 'other', deviceId: 'host', sessionId: 's', text: 'not mine', createdAt: 4 },
  ]
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction('inputs', 'readwrite')
    for (const row of old) tx.objectStore('inputs').put(row)
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
  })
  legacy.close()
  install({ send: () => new Promise<void>(() => {}) })
  await importLegacyWrites('owner')
  await settle()
  expect(rows().map(row => [row.id, row.admission ?? null, !!row.sendQueue])).toEqual(expect.arrayContaining([
    ['plain', null, false], ['held', null, true], ['refused', 'rejected', false],
  ]))
  expect(rows().find(row => row.id === 'held')?.sendQueue?.afterInputId).toBe('plain')
  expect(rows().some(row => row.id === 'someone-else')).toBe(false)
  await importLegacyWrites('owner')
  expect(rows()).toHaveLength(3)
})

describe('a bubble reads the one custody owner of its messageId', () => {
  const sender = (id: string, createdAt: number, extra: Partial<SessionInput> = {}): SessionInput =>
    ({ id, accountId: 'owner', deviceId: null, sessionId: 'agent', text: `sender ${id}`, createdAt, ...extra })
  const host = (seq: number, messageId: string, state: HostPendingRow['state'], over: Partial<HostPendingRow> = {}): HostPendingRow =>
    ({ seq, messageId, preview: `host ${messageId}`.slice(0, 4), text: `host ${messageId}`, kind: 'session-direct', sentAt: 0, state, failure: null, ...over })

  it('a row behind a person\'s stop says so: it goes with their next message, it is not on its way', () => {
    expect(sessionInputBubbles([], [host(1, 'q', 'queued')], 'user-stop')[0]?.state).toBe('stopped')
    expect(sessionInputBubbles([], [host(1, 'q', 'queued')], 'sign-out')[0]?.state).toBe('sending')
  })

  it('sender row until the host row exists, the host row until accepted, then nothing (the transcript has it)', () => {
    expect(sessionInputBubbles([sender('m', 1)], [], null)).toEqual([{ id: 'm', text: 'sender m', state: 'sending' }])
    // A queued message from another task is a delivery: its sender and body, the way the transcript reads it, never the envelope.
    const envelope = buildSessionDirectEnvelope({ senderSessionId: 'other-task', senderTitle: 'Builder', messageId: 'd', content: 'the run finished', at: '2026-11-01 08:00 北京时间' })
    const [delivered] = sessionInputBubbles([], [{ ...host(1, 'd', 'queued'), text: envelope, kind: 'session-direct' }], 'start-failed')
    expect(delivered).toMatchObject({ id: 'd', text: 'the run finished', from: 'Builder', state: 'failed', failure: null, hostReason: null })
    expect(delivered!.text).not.toContain('<gugu_delivery')
    expect(sessionInputBubbles([sender('m', 1)], [host(1, 'm', 'dispatching')], null)).toEqual([{ id: 'm', text: 'host m', state: 'sending' }])
    expect(sessionInputBubbles([sender('m', 1)], [host(1, 'm', 'accepted')], null)).toEqual([])
    expect(sessionInputBubbles([], [host(1, 'm', 'accepted')], null)).toEqual([])
  })

  it('a queued inbox batch is a pending row like any other (one projection); a failed host row says the host\'s reason', () => {
    expect(sessionInputBubbles([], [host(1, 'mail', 'queued', { kind: 'inbox-batch' })], null)).toEqual([{ id: 'mail', text: 'host mail', state: 'sending' }])
    expect(sessionInputBubbles([], [host(1, 'f', 'failed', { failure: 'The session stopped before dispatch' })], null))
      .toEqual([{ id: 'f', text: 'host f', state: 'failed', failure: null, hostReason: 'The session stopped before dispatch' }])
  })

  it('names each state: queued sending, waiting with the sender reason, undelivered after its attempts, the host failure, unknown not resent', () => {
    expect(sessionInputBubbles(
      [sender('b', 2, { failure: { code: 'host-offline' } }), sender('a', 1), sender('c', 3, { failure: { code: 'no-acknowledgement' }, undelivered: true })],
      [host(3, 'q', 'queued'), host(1, 'f', 'failed'), host(2, 'u', 'unknown')],
      null,
    ).map(bubble => [bubble.id, bubble.state, bubble.state === 'failed' || bubble.state === 'waiting' || bubble.state === 'undelivered' ? bubble.failure : null])).toEqual([
      ['f', 'failed', null], ['u', 'unknown', null], ['q', 'sending', null],
      ['a', 'sending', null], ['b', 'waiting', { code: 'host-offline' }], ['c', 'undelivered', { code: 'no-acknowledgement' }],
    ])
  })

  it('a host row draws its full text, never the summary preview', () => {
    const long = 'x'.repeat(400)
    expect(sessionInputBubbles([], [host(1, 'm', 'queued', { text: long, preview: long.slice(0, 160) })], null)[0]?.text).toBe(long)
  })

  it('a failed start marks the queued host batch failed; sender requests keep their own state', () => {
    expect(sessionInputBubbles([sender('s', 1)], [host(1, 'q', 'queued'), host(2, 'd', 'dispatching')], 'start-failed')
      .map(bubble => [bubble.id, bubble.state])).toEqual([['q', 'failed'], ['d', 'failed'], ['s', 'sending']])
  })

  it.each([
    ['start-failed', 'failed'], ['effect-fault', 'failed'], ['sign-out', 'sending'], ['user-stop', 'stopped'], [null, 'sending'],
  ] as const)('projects hold %s without treating sign-out as a send failure', (hold, state) => {
    expect(sessionInputBubbles([], [host(1, 'q', 'queued'), host(2, 'd', 'dispatching')], hold).map(b => b.state)).toEqual([state, state])
  })
})
