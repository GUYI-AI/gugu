import { lifeHoldIsFailure, type LifeView } from '@/session/shared/core/sessions/session-life'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import type { SessionInputAdmission } from '@gugu/core/shared/sessionInputAdmission'
import { translateSessionMessage } from '@renderer/localization/locale-store'
export type SessionInput = {
  id: string; accountId: string; deviceId: string | null; sessionId: string; text: string; createdAt: number
  attachments?: import('@gugu/session-core/session-record/contract').SessionpageSessionSendRequest['attachments']
  files?: import('@gugu/session-core/session-record/contract').TurnFileRef[]
  annotations?: import('@gugu/session-core/session-record/contract').SessionpageSessionSendRequest['annotations']
  failure?: SessionInputFailure
  /** Only the receiving boundary can stop automatic recovery: a refused input waits for the person. */
  admission?: Exclude<SessionInputAdmission, 'accepted'>
  /** Not answered after its attempts: shown undelivered, and sent again when its host or the network comes back. */
  undelivered?: true
  /** Presentation only: an explicitly queued input remains in the composer queue. */
  queued?: boolean
  /** Composer-owned, not yet sent. Legacy/mobile `queued` alone is only presentation. */
  sendQueue?: { order: number; afterInputId?: string; edit?: { draftText: string; originalDraftText: string } }
  baseline?: string[]
  afterTurnId?: string
  /** The send queue released this input after `afterTurnId`, read from the record its releaser checked.
   * A page drawing an older record shows it as queued until that turn is on the page (#2367). */
  releasedFromQueue?: true
  /** Explicit send-now insertion, never used by automatic queue release. */
  steerIfBusy?: true
}
/** Failures the sender itself names; any other send error keeps the host's own words. */
export type SessionInputFailure =
  | { code: 'host-offline' }
  | { code: 'host-not-ready' }
  | { code: 'phone-unconfirmed' }
  | { code: 'no-acknowledgement' }
  | { code: 'send-failed'; message: string }
export class SessionInputFailureError extends Error {
  constructor(readonly failure: Exclude<SessionInputFailure, { code: 'send-failed' }>) { super(failure.code) }
}
/** A host session_pending row as its LifeView shows it. */
export type HostPendingRow = LifeView['pending']['items'][number]
/** from: a delivery (another task's or agent's message) shows its sender and body, read the way the transcript reads it. */
export type SessionInputBubble = { id: string; text: string; from?: string | null } & (
  | { state: 'sending' }
  /** The person stopped the session before it went: it goes with their next message. */
  | { state: 'stopped' }
  /** The durable sender still owns this input and will automatically retry it. */
  | { state: 'waiting'; failure: SessionInputFailure }
  /** Not answered after its attempts: red, and still sent again on its own once its host or the network is back. */
  | { state: 'undelivered'; failure: SessionInputFailure }
  /** The host owns a failed row, or explicitly refused to take the sender's input. */
  | { state: 'failed'; failure: SessionInputFailure | null; hostReason: string | null }
  | { state: 'unknown' })

/**
 * Custody of a messageId has one owner at a time: the transcript once the host row is accepted, else the host row,
 * else the sender row. A bubble is drawn from whichever owns it; the transcript draws its own.
 */
export function sessionInputBubbles(sender: readonly SessionInput[], host: readonly HostPendingRow[], hold: LifeView['hold']): SessionInputBubble[] {
  const hosted = new Set(host.map(row => row.messageId))
  return [
    // Every pending row, whatever wrote it (the person, another task, the inbox): one projection of the queue.
    ...[...host].sort((a, b) => a.seq - b.seq).flatMap((row): SessionInputBubble[] => {
      const delivered = readDeliveryEnvelope(row.text)
      const base = delivered ? { id: row.messageId, text: delivered.body, from: delivered.segments[0]?.facts?.from ?? null } : { id: row.messageId, text: row.text }
      switch (row.state) {
        case 'accepted': return []
        case 'queued': case 'dispatching':
          if (hold === 'user-stop') return [{ ...base, state: 'stopped' }]
          return [lifeHoldIsFailure(hold) ? { ...base, state: 'failed', failure: null, hostReason: null } : { ...base, state: 'sending' }]
        case 'failed': return [{ ...base, state: 'failed', failure: null, hostReason: row.failure }]
        case 'unknown': return [{ ...base, state: 'unknown' }]
      }
    }),
    ...[...sender].filter(input => !hosted.has(input.id)).sort((a, b) => a.createdAt - b.createdAt)
      .map((input): SessionInputBubble => ({ id: input.id, text: input.text,
        ...(input.admission === 'rejected' ? { state: 'failed', failure: input.failure ?? null, hostReason: null }
          : input.undelivered && input.failure ? { state: 'undelivered', failure: input.failure }
          : input.failure ? { state: 'waiting', failure: input.failure } : { state: 'sending' }) })),
  ]
}

/** A queued file sent to an old host keeps its caption and explains what was omitted. */
export function withoutQueuedAttachments(input: SessionInput, count: number): SessionInput {
  const { files: _files, failure: _failure, ...body } = input
  return { ...body, text: [input.text, translateSessionMessage('composer.attachmentsNotSent', { count })].filter(Boolean).join('\n\n') }
}
/** How long a send-now or a phone task send waits for its host to answer; the outbox keeps its own deadline. */
export async function withSessionInputDeadline<T>(operation: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SessionInputFailureError({ code: 'no-acknowledgement' })), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
