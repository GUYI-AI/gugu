// @@@session-input-outbox — the person's input to a session, as the outbox kind `sessionInput`.
//   · lane = the session on its host: one session's inputs go in order; a host that hangs holds up only its own sessions;
//   · a composer-queued input is a held write: it stays on disk, in the person's order, until the queue releases it after
//     the turn it waits for (or the person sends it now);
//   · the id is the input's clientMessageId: the host takes it once ([conversationId, clientMessageId] and session_pending);
//   · a host that refuses an input (its admission) fails it for the person to retry, edit or discard; one that does not
//     answer is tried again, shown undelivered after three retries, and sent again when hosts or the network come back.
// The rest of the renderer reads these writes as SessionInput rows (state().rows), the shape the composer and the
// transcript draw.

import { useMemo, useSyncExternalStore } from 'react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { nativeMessageKey } from '@gugu/session-core/session-record/native-read'
import { sessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission'
import { liveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { sessionInputBaseline } from '../../pendingSessionInput'
import { SessionInputFailureError, type SessionInput, type SessionInputFailure } from '../../sessionInput'
import { outbox, OutboxRejected, OutboxTimeout, type OutboxFailure, type OutboxItem, type OutboxKind } from '..'

export const SESSION_INPUT = 'sessionInput'
const HOST_ANSWER_MS = 30_000

/** What is stored; the outbox keeps the id, the account, the order and the outcome. */
export type SessionSend = Omit<SessionInput, 'id' | 'accountId' | 'failure' | 'admission' | 'undelivered'>

const CODES = new Set(['host-offline', 'host-not-ready', 'phone-unconfirmed', 'no-acknowledgement'])
function failureOf(failure: OutboxFailure): SessionInputFailure {
  return failure.code && CODES.has(failure.code) ? { code: failure.code } as SessionInputFailure : { code: 'send-failed', message: failure.message }
}

const sendOf = (input: SessionInput): SessionSend => {
  const { id: _id, accountId: _account, failure: _failure, admission: _admission, undelivered: _undelivered, ...send } = input
  return send
}

export function inputOf(item: OutboxItem<SessionSend>): SessionInput {
  const { sendQueue, ...send } = item.payload
  const held = item.state === 'held'
  return {
    ...send, id: item.id, accountId: item.accountId,
    ...(held ? { queued: true, sendQueue: { ...sendQueue, order: item.order } } : {}),
    ...(!held && item.failure ? { failure: failureOf(item.failure) } : {}),
    ...(item.state === 'failed' && item.failure?.reason !== 'unreachable' ? { admission: 'rejected' as const } : {}),
    ...(item.state === 'failed' && item.failure?.reason === 'unreachable' ? { undelivered: true as const } : {}),
  }
}

export function sessionInputKind(deps: {
  /** Before each attempt: the input as this host can take it (files it cannot receive become a note in the text). */
  prepare(input: SessionInput): Promise<SessionInput>
  /** Hands the input to its host; throws SessionInputFailureError / an admission error when it is not taken. */
  send(input: SessionInput): Promise<void>
  onState?(input: SessionInput, state: OutboxItem['state']): void
  onSettled?(input: SessionInput): void
}): OutboxKind<SessionSend> {
  const settled = (item: OutboxItem<SessionSend>) => {
    publishRows()
    deps.onSettled?.(inputOf(item))
  }
  return {
    name: SESSION_INPUT,
    lane: (send) => `session:${send.deviceId ?? 'local'}/${send.sessionId}`,
    timeoutMs: HOST_ANSWER_MS,
    async prepare(item) {
      return { ...item, payload: sendOf(await deps.prepare(inputOf(item))) }
    },
    async send(item) {
      // A host that took the input and failed afterwards (a notification) still took it.
      try { await deps.send(inputOf(item)) } catch (error) { if (sessionInputAdmission(error) !== 'accepted') throw error }
    },
    failure(error): OutboxFailure {
      if (error instanceof OutboxTimeout) return { reason: 'unreachable', message: 'no-acknowledgement', code: 'no-acknowledgement' }
      if (error instanceof SessionInputFailureError) return { reason: 'unreachable', message: error.failure.code, code: error.failure.code }
      const message = error instanceof Error ? error.message : String(error)
      // Only the receiving boundary can refuse: anything else is sent again.
      return { reason: sessionInputAdmission(error) === 'rejected' || error instanceof OutboxRejected ? 'rejected' : 'unreachable', message, code: 'send-failed' }
    },
    onState: (item) => {
      publishRows()
      deps.onState?.(inputOf(item), item.state)
    },
    onAck: settled,
    onDiscard: settled,
  }
}

// ── the rows the renderer reads (shared by every bundle in this window) ────────────────────────────────────────────

type State = { accountId: string | null; rows: readonly SessionInput[]; listeners: Set<() => void>; valid: () => boolean }
const KEY = '__GUGU_NATIVE_INPUT_OUTBOX__'
export const EMPTY: readonly SessionInput[] = []
const fallback: State = { accountId: null, rows: EMPTY, listeners: new Set(), valid: () => false }
export const state = (): State => {
  if (typeof window === 'undefined') return fallback
  const host = window as unknown as Record<string, unknown>
  return (host[KEY] ??= { accountId: null, rows: EMPTY, listeners: new Set(), valid: () => false }) as State
}
export const changed = () => { for (const listener of [...state().listeners]) listener() }
export const sessionInputOutboxAvailable = (): boolean => state().valid()

/** The account's session inputs as rows, in lane order (held ones by their place in the queue). */
export function publishRows(): void {
  const own = state()
  const rows = own.valid() ? (outbox().items() as OutboxItem<SessionSend>[]).filter(item => item.kind === SESSION_INPUT && item.accountId === own.accountId).map(inputOf) : EMPTY
  own.rows = rows.length ? rows : EMPTY
  changed()
}

function requireAvailable(): void {
  if (!state().valid()) throw new Error('Session input outbox is not available for this account')
}

/** Every change to the session queue goes in this order: a deleted or edited input cannot race a release. */
let writing: Promise<unknown> = Promise.resolve()
function write<T>(operation: () => Promise<T>): Promise<T> {
  const written = writing.catch(() => undefined).then(() => { requireAvailable(); return operation() })
  writing = written
  return written
}
const sessionRows = (sessionId: string) => state().rows.filter(row => row.sessionId === sessionId)

/** Checked before an input is taken (a host too old for its files refuses here, before it is queued). */
let beforeEnqueue: (input: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'files' | 'attachments' | 'annotations'>) => void = () => {}
export function setSessionInputEnqueueCheck(check: typeof beforeEnqueue): () => void {
  beforeEnqueue = check
  return () => { if (beforeEnqueue === check) beforeEnqueue = () => {} }
}

export function enqueueSessionInput(target: Pick<SessionInput, 'deviceId' | 'sessionId' | 'text' | 'files' | 'attachments' | 'annotations' | 'queued' | 'baseline' | 'afterTurnId' | 'sendQueue'> & { composer?: true }): Promise<SessionInput> {
  return write(async () => {
    beforeEnqueue(target)
    const { composer, ...body } = target
    const previous = sessionRows(target.sessionId).filter(row => row.deviceId === target.deviceId && row.admission !== 'rejected')
    const afterInputId = previous.find(row => !row.sendQueue)?.id ?? previous.find(row => row.sendQueue)?.sendQueue?.afterInputId
    const sendQueue = target.sendQueue ?? (composer && previous.length ? { order: 0, ...(afterInputId ? { afterInputId } : {}) } : undefined)
    const item = await outbox().enqueue<SessionSend>(SESSION_INPUT, { ...body, ...(sendQueue ? { queued: true, sendQueue } : {}), createdAt: Date.now() }, { hold: !!sendQueue })
    publishRows()
    return inputOf(item)
  })
}

/** The person asked to send the undelivered inputs again now (they also go again on their own when hosts come back). */
export async function retrySessionInputs(): Promise<void> {
  requireAvailable()
  outbox().kick(SESSION_INPUT)
}

/** The clicked input only: a refused or undelivered one goes again with a fresh budget. */
export function retrySessionInput(id: string): Promise<void> {
  return write(() => outbox().retry(id))
}

export function changeRejectedSessionInput(id: string, action: { kind: 'retry' } | { kind: 'edit'; text: string } | { kind: 'discard' }): Promise<void> {
  return write(async () => {
    const input = state().rows.find(row => row.id === id)
    if (!input || input.admission !== 'rejected') throw new Error('Session input is not awaiting a manual decision')
    if (action.kind === 'retry') return outbox().retry(id)
    if (action.kind === 'edit') {
      if (!action.text.trim()) throw new Error('Session input is empty')
      await outbox().edit(id, { ...sendOf(input), text: action.text })
      return
    }
    // Inputs queued after it wait for the one before it instead.
    for (const row of sessionRows(input.sessionId).filter(row => row.sendQueue?.afterInputId === id)) {
      const { afterInputId: _after, ...sendQueue } = row.sendQueue!
      await outbox().edit(row.id, { ...sendOf(row), sendQueue })
    }
    await outbox().discard(id)
  })
}

export function editQueuedSessionInput(id: string, text: string, edit?: { draftText: string; originalDraftText: string } | null): Promise<boolean> {
  return write(async () => {
    const input = state().rows.find(row => row.id === id && row.sendQueue)
    if (!input) return false
    return !!await outbox().edit(id, { ...sendOf(input), text, sendQueue: { ...input.sendQueue!, ...(edit === undefined ? {} : { edit: edit ?? undefined }) } })
  })
}

export function deleteQueuedSessionInput(id: string): Promise<boolean> {
  return write(async () => {
    if (!state().rows.some(row => row.id === id && row.sendQueue)) return false
    await outbox().discard(id)
    return true
  })
}

export function reorderQueuedSessionInputs(sessionId: string, ids: readonly string[]): Promise<void> {
  return write(async () => {
    const queued = sessionRows(sessionId).filter(row => row.sendQueue)
    if (ids.length !== queued.length || new Set(ids).size !== ids.length || ids.some(id => !queued.some(input => input.id === id))) {
      throw new Error('Send queue identities changed; reload its order')
    }
    await outbox().reorder(ids)
  })
}

/** Call only with an authoritative foreground-idle snapshot, or the person's explicit send-now action. */
export async function releaseQueuedSessionInput(sessionId: string, turns: readonly TranscriptTurn[], nowId?: string, steers = false, canRelease: () => boolean = () => true): Promise<SessionInput | null> {
  if (steers && !sessionInputSteeringAvailable(sessionId)) throw new Error(translateSessionMessage('composer.steeringHostUpdateRequired'))
  const completed = new Set<string>()
  for (const turn of turns) if (turn.outcome) for (const item of turn.items) if (item.kind === 'message' && item.role === 'user') {
    completed.add(nativeMessageKey(item.id))
    if (typeof item._meta?.guguClientMessageId === 'string') completed.add(item._meta.guguClientMessageId)
  }
  return write(async () => {
    const rows = sessionRows(sessionId)
    // One foreground completion releases one input, never all of a session's queue.
    if (!canRelease() || (!nowId && rows.some(row => !row.sendQueue && row.admission !== 'rejected'))) return null
    const queued = rows.filter(row => row.sendQueue).sort((a, b) => a.sendQueue!.order - b.sendQueue!.order)
    const input = nowId ? queued.find(row => row.id === nowId) : queued[0]
    const predecessor = input?.sendQueue?.afterInputId
    if (!input || input.sendQueue!.edit || (!nowId && predecessor && !completed.has(predecessor)
      && !rows.some(row => row.id === predecessor && row.admission === 'rejected'))) return null
    // Remaining entries wait for this exact input to finish, including across a restart.
    for (const row of queued.filter(row => row.id !== input.id)) await outbox().edit(row.id, { ...sendOf(row), sendQueue: { ...row.sendQueue!, afterInputId: input.id } })
    const { sendQueue: _queue, ...released } = sendOf(input)
    const sent = await outbox().release<SessionSend>(input.id, { ...released, ...sessionInputBaseline(turns), queued: false, releasedFromQueue: true, ...(steers ? { steerIfBusy: true } : {}) })
    publishRows()
    return sent ? inputOf(sent) : null
  })
}

/**
 * The host's first answer to a send-now: resolves when it took the input, rejects on the first attempt that did not (the
 * input itself stays in the outbox and keeps its own retries; the person who pressed "send now" hears at once).
 */
export const sessionInputTaken = (id: string): Promise<void> => outbox().answered(id)

export function sessionInputSteeringAvailable(sessionId: string): boolean {
  return Object.values(liveDeviceSessions()).some(host => !host.cached && host.connected === true && !host.error
    && host.sessions.some(session => session.conversationId === sessionId && session.nativeInputSteering === true))
}

export function useQueuedSessionInputs(sessionId: string): readonly SessionInput[] {
  const rows = useSyncExternalStore(subscribeSessionInputs, () => state().rows, () => EMPTY)
  return useMemo(() => rows.filter(row => row.sessionId === sessionId), [rows, sessionId])
}

/** Non-React transcript stores observe the same account-scoped sender rows as the phone. */
export function queuedSessionInputs(sessionId: string): readonly SessionInput[] {
  return state().valid() ? sessionRows(sessionId) : EMPTY
}

export function subscribeSessionInputs(listener: () => void): () => void {
  state().listeners.add(listener)
  return () => { state().listeners.delete(listener) }
}

export function useSessionInputAccount(): string | null {
  return useSyncExternalStore(subscribeSessionInputs, () => state().valid() ? state().accountId : null, () => null)
}
