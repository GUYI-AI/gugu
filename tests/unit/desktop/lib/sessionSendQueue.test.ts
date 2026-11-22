/**
 * The composer-owned send queue: held session inputs in the one outbox, released one at a time after the turn they wait
 * for. Driven through the composer's own API over a real outbox; only the host transport and the disk are the test's.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { SessionInputAdmissionError } from '@gugu/core/shared/sessionInputAdmission'
import type { SessionInput } from '@/lib/sessionInput'
import {
  changeRejectedSessionInput, deleteQueuedSessionInput, editQueuedSessionInput, enqueueSessionInput, releaseQueuedSessionInput,
  reorderQueuedSessionInputs, retrySessionInputs, state,
} from '@/lib/outbox/kinds/sessionInput'
import { installSessionInputOutbox, memoryOutboxStorage, settle, type InstalledSessionInputs } from '../../../helpers/sessionInputOutbox'

const target = { deviceId: 'remote', sessionId: 'session', queued: true, sendQueue: { order: 0 }, text: '好' }
let installed: InstalledSessionInputs | undefined
const install = (...args: Parameters<typeof installSessionInputOutbox>) => (installed?.dispose(), installed = installSessionInputOutbox(...args))
afterEach(() => { installed?.dispose(); installed = undefined })
const rows = () => state().rows
/** A finished turn whose user message is the input `id` (as the host echoes it). */
const finished = (id: string, turnId = 'turn'): TranscriptTurn[] => [{ id: turnId, seq: 1, initiator: 'user', outcome: { kind: 'done' },
  items: [{ kind: 'message', role: 'user', id: `native-${id}`, _meta: { guguClientMessageId: id } }] } as unknown as TranscriptTurn]
const refused = async () => { throw new SessionInputAdmissionError('refused', 'rejected') }

describe('composer-owned durable send queue', () => {
  it('does not make a definitive refusal hold later independent composer submissions', async () => {
    install({ send: refused })
    const first = await enqueueSessionInput({ ...target, queued: false, sendQueue: undefined })
    const held = await enqueueSessionInput({ ...target, sendQueue: { order: 0, afterInputId: first.id } })
    await settle()
    expect(rows().find(row => row.id === first.id)).toMatchObject({ admission: 'rejected' })
    expect(await releaseQueuedSessionInput('session', [])).toMatchObject({ id: held.id })
    await settle()
    const next = await enqueueSessionInput({ ...target, queued: false, sendQueue: undefined, composer: true })
    expect(next.sendQueue).toBeUndefined()
  })

  it('discards a rejected predecessor without stranding its held follower after reopening', async () => {
    const storage = memoryOutboxStorage()
    install({ send: refused, storage })
    const first = await enqueueSessionInput({ ...target, queued: false, sendQueue: undefined })
    const held = await enqueueSessionInput({ ...target, sendQueue: { order: 0, afterInputId: first.id } })
    await settle()
    await changeRejectedSessionInput(first.id, { kind: 'discard' })
    install({ send: refused, storage })
    await installed!.outbox.loaded(); await settle()
    expect(rows().find(row => row.id === held.id)?.sendQueue?.afterInputId).toBeUndefined()
    expect(await releaseQueuedSessionInput('session', [])).toMatchObject({ id: held.id })
  })

  it('checks the latest host permission inside the write order before releasing', async () => {
    install({ send: async () => {} })
    const input = await enqueueSessionInput(target)
    let idle = true
    const release = releaseQueuedSessionInput('session', [], undefined, false, () => idle)
    idle = false
    expect(await release).toBeNull()
    expect(rows()).toMatchObject([{ id: input.id, sendQueue: expect.any(Object) }])
  })

  it('classifies two same-frame composer submissions in their write order', async () => {
    const sent: string[] = []
    install({ send: async input => { sent.push(input.id) } })
    const submit = { deviceId: 'remote', sessionId: 'session', text: '好', queued: false, composer: true as const }
    const [first, second] = await Promise.all([enqueueSessionInput(submit), enqueueSessionInput(submit)])
    expect(first.sendQueue).toBeUndefined()
    expect(second.sendQueue).toMatchObject({ afterInputId: first.id })
    await settle()
    expect(sent).toEqual([first.id])
  })

  it('does not send a held input on enqueue, recovery, manual retry or restart', async () => {
    const storage = memoryOutboxStorage()
    const sent: string[] = []
    const send = async (input: SessionInput) => { sent.push(input.id) }
    install({ send, storage })
    const input = await enqueueSessionInput(target)
    await settle()
    await retrySessionInputs(); await settle()
    install({ send, storage })
    await installed!.outbox.loaded(); await settle()
    expect(sent).toEqual([])
    expect(rows()).toMatchObject([{ id: input.id, text: '好', sendQueue: expect.any(Object) }])
  })

  it('edits, deletes and reorders the actual persistent queue before any transport request', async () => {
    const sent: string[] = []
    install({ send: async input => { sent.push(input.text) } })
    const a = await enqueueSessionInput(target)
    const b = await enqueueSessionInput(target)
    const c = await enqueueSessionInput(target)
    expect(a.id).not.toBe(b.id)
    await editQueuedSessionInput(b.id, 'edited', { draftText: 'editing', originalDraftText: 'my draft' })
    await reorderQueuedSessionInputs('session', [c.id, b.id, a.id])
    expect(await deleteQueuedSessionInput(a.id)).toBe(true)
    await settle()
    expect(sent).toEqual([])
    const queued = [...rows()].sort((x, y) => x.sendQueue!.order - y.sendQueue!.order)
    expect(queued.map(row => row.id)).toEqual([c.id, b.id])
    expect(queued[1]).toMatchObject({ text: 'edited', sendQueue: { edit: { draftText: 'editing', originalDraftText: 'my draft' } } })
  })

  it('holds the editing entry, then releases exactly one and waits for its own completed id, across a restart', async () => {
    const storage = memoryOutboxStorage()
    const sent: string[] = []
    const send = async (input: SessionInput) => { sent.push(input.id) }
    install({ send, storage })
    const a = await enqueueSessionInput(target)
    const b = await enqueueSessionInput(target)
    await editQueuedSessionInput(a.id, '好', { draftText: 'next', originalDraftText: 'draft' })
    expect(await releaseQueuedSessionInput('session', [])).toBeNull()
    await editQueuedSessionInput(a.id, 'next', null)
    expect(await releaseQueuedSessionInput('session', finished('old', 'old-turn'))).toMatchObject({ id: a.id, queued: false, afterTurnId: 'old-turn' })
    await settle()
    expect(sent).toEqual([a.id])
    expect(await releaseQueuedSessionInput('session', finished('another-message-id'))).toBeNull()
    install({ send, storage })
    await installed!.outbox.loaded(); await settle()
    expect(await releaseQueuedSessionInput('session', [])).toBeNull()
    expect(await releaseQueuedSessionInput('session', finished(a.id))).toMatchObject({ id: b.id, queued: false })
    await settle()
    expect(sent).toEqual([a.id, b.id])
  })

  it('does not bypass an ordinary offline input while releasing its queued follower', async () => {
    install({ send: async () => { throw new Error('offline') } })
    await enqueueSessionInput({ deviceId: 'remote', sessionId: 'session', text: 'first', queued: false })
    await enqueueSessionInput(target)
    await settle()
    expect(await releaseQueuedSessionInput('session', [])).toBeNull()
    expect(rows()).toHaveLength(2)
  })

  it('serializes removal before release so a deleted message never reaches transport', async () => {
    const sent: string[] = []
    install({ send: async input => { sent.push(input.id) } })
    const input = await enqueueSessionInput(target)
    const removed = deleteQueuedSessionInput(input.id)
    const released = releaseQueuedSessionInput('session', [])
    expect(await removed).toBe(true)
    expect(await released).toBeNull()
    await settle()
    expect(sent).toEqual([])
  })
})
