// @@@send-outbox — chat messages (text, cards, files, forwards, new topics) as the outbox kind `chatMessage`. The outbox
// (lib/outbox) owns persistence, lanes, retries, the deadline and the account; this file only says what a chat send is:
//   · lane = the chat: messages of one chat go in order, other chats are not held up;
//   · a file still uploading keeps its place in the lane (its row waits for its commit, so does what was sent after it);
//   · a send that follows another (the files sent with a text, a forwarded source, a topic's source) waits for it;
//   · the id is the message id (client_message_id): every send of the same row converges on one message.
// The chat store reads each write as an OutboxRecord, the shape its optimistic rows are drawn from.

import type { OutboxRecord } from '../lib/imRepository'
import { i18n } from '@/i18n'
import { OUTBOX_TIMEOUT_MS, OutboxRejected, OutboxTimeout, isServerRefusal, type Outbox, type OutboxFailure, type OutboxItem } from '../lib/outbox'
import { chatSendTimings, finishChatSendTiming } from '../lib/chatSendTiming'

export const CHAT_MESSAGE = 'chatMessage'
/** A native publication hashes and records the file on this device first; it gets longer than a request. */
const NATIVE_PUBLICATION_MS = 10 * 60_000

/** What is stored: the record without the outbox's own state. */
export type ChatSend = Omit<OutboxRecord, 'clientMessageId' | 'dependsOn' | 'dependencyDiscarded' | 'state' | 'attempts' | 'lastError' | 'updatedAt'> & {
  /** The file's bytes are being declared: the row holds its lane until its commit. */
  uploading?: true
}

/** Thrown by `deliver` when the row's uploaded bytes can no longer be sent: the row fails as one whose file must go up again. */
export class UploadAgainError extends OutboxRejected {
  /** `held`: this run still holds the file, so the person can resend it; otherwise it must be selected again. */
  constructor(readonly held: boolean) {
    super(held ? i18n.t('composer.failureReason.timeout', { ns: 'messaging' }) : i18n.t('outbox.selectFileAgain', { ns: 'messaging' }), 'needs-file')
  }
}

const needsFile = (item: OutboxItem<ChatSend>) => item.state === 'failed' && item.failure?.reason === 'needs-file'

export function recordOf(item: OutboxItem<ChatSend>): OutboxRecord {
  const { uploading, ...payload } = item.payload
  return {
    ...payload,
    // A row whose bytes must go up again is an upload again, whatever it was committing.
    ...(needsFile(item) ? { operation: { kind: 'upload' as const } } : {}),
    clientMessageId: item.id,
    ...(item.dependsOn[0] ? { dependsOn: item.dependsOn[0] } : {}),
    ...(item.failure?.reason === 'dependency' ? { dependencyDiscarded: true } : {}),
    state: item.state === 'failed' ? 'failed' : uploading ? 'uploading' : item.state === 'sending' ? 'sending' : 'pending',
    attempts: item.attempts,
    lastError: item.failure?.message ?? null,
    updatedAt: payload.enqueuedAt,
  }
}

function sendOf(record: OutboxRecord, uploading: boolean): ChatSend {
  const { clientMessageId: _id, dependsOn: _dependsOn, dependencyDiscarded: _discarded, state: _state, attempts: _attempts, lastError: _error, updatedAt: _updated, ...send } = record
  return uploading ? { ...send, uploading: true } : send
}

export interface ChatOutboxDeps {
  /** Before each attempt, outside its deadline: the session made ready, the DM peer resolved. */
  prepare?(record: OutboxRecord): Promise<OutboxRecord>
  /** Sends the record; idempotent on its id. Returns the authoritative row. */
  deliver(record: OutboxRecord, signal: AbortSignal): Promise<unknown>
  /** Durable completion: the confirmed message written where it is read, before the write leaves the outbox. */
  ack?(record: OutboxRecord, delivered: unknown): Promise<unknown>
  /** Every change of a write → its optimistic row. */
  onState(record: OutboxRecord): void
  /** Confirmed: side effects (watermark, preview). The write has left the outbox. */
  onSent(record: OutboxRecord, acknowledged: unknown): void | Promise<void>
  onDiscarded(record: OutboxRecord): void
  /** The position a new row takes in its conversation (kept in the record until it is confirmed). */
  position?(record: OutboxRecord): Promise<OutboxRecord>
}

export interface ChatOutbox {
  dispose(): void
  /** Durable enqueue: resolves once on disk, not when delivered. */
  enqueue(record: OutboxRecord): Promise<void>
  retry(clientMessageId: string): Promise<void>
  /** A file row that keeps its place while its bytes are declared. */
  stageUpload(record: OutboxRecord): Promise<void>
  commitUpload(record: OutboxRecord): Promise<boolean>
  has(clientMessageId: string): boolean
  /** `reason`: what the failed row says; absent, the file must be selected again. */
  failUpload(clientMessageId: string, error: unknown, reason?: string): Promise<void>
  /** A failed upload whose bytes this run still holds goes back to uploading; false when it is no longer a failed upload. */
  resumeUpload(clientMessageId: string): Promise<boolean>
  discard(clientMessageId: string): Promise<void>
  /** The account's chat writes once loaded; uploads interrupted by a restart now need their file again. */
  restore(): Promise<OutboxRecord[]>
  pendingFor(chatId: string, threadRootId: string | null): OutboxRecord[]
  /** Resolves when confirmed; rejects when it fails or is discarded. */
  delivered(clientMessageId: string): Promise<void>
}

export function createChatOutbox(outbox: Outbox, deps: ChatOutboxDeps): ChatOutbox {
  const chatItem = (id: string) => {
    const item = outbox.get<ChatSend>(id)
    return item?.kind === CHAT_MESSAGE ? item : undefined
  }
  const unregister = outbox.register<ChatSend, unknown>({
    name: CHAT_MESSAGE,
    lane: (send) => `chat:${send.chatId}`,
    ready: (item) => !item.payload.uploading,
    timeoutMs: (item) => item.payload.operation?.kind === 'nativeAttachment' ? NATIVE_PUBLICATION_MS : OUTBOX_TIMEOUT_MS,
    prepare: deps.prepare && (async (item) => {
      const record = recordOf(item)
      const prepared = await deps.prepare!(record)
      return prepared === record ? item : { ...item, payload: sendOf(prepared, false) }
    }),
    async send(item, signal) {
      const delivered = await deps.deliver(recordOf(item), signal)
      const timing = chatSendTimings.get(item.id); if (timing) timing.response = performance.now()
      return delivered
    },
    complete: deps.ack && ((item, delivered) => deps.ack!(recordOf(item), delivered)),
    failure: (error): OutboxFailure => error instanceof OutboxRejected ? { reason: error.reason, message: error.message }
      : isServerRefusal(error) ? { reason: 'rejected', message: error instanceof Error ? error.message : String(error) }
      : { reason: 'unreachable', message: error instanceof OutboxTimeout ? i18n.t('outbox.deliveryTimeout', { ns: 'messaging', seconds: OUTBOX_TIMEOUT_MS / 1000 })
        : error instanceof Error ? error.message : String(error) },
    blocked: (item, source) => i18n.t(source.failure?.reason === 'dependency' ? 'outbox.sourceDiscarded' : item.payload.operation?.kind === 'forward' ? 'outbox.sourceNotSent' : 'outbox.followedNotSent', { ns: 'messaging' }),
    onState: (item) => deps.onState(recordOf(item)),
    onAck: (item, acknowledged) => {
      finishChatSendTiming(item.id, true)
      // Side effects have no deadline (a summary refresh): never awaited by the lane; their failure reports itself.
      void Promise.resolve(deps.onSent(recordOf(item), acknowledged)).catch((error) => console.error('[chatOutbox] onSent side effects failed', error))
    },
    onDiscard: (item) => deps.onDiscarded(recordOf(item)),
  })

  async function put(record: OutboxRecord, uploading: boolean): Promise<void> {
    const positioned = deps.position ? await deps.position(record) : record
    await outbox.enqueue(CHAT_MESSAGE, sendOf(positioned, uploading), { id: record.clientMessageId, ...(record.dependsOn ? { dependsOn: [record.dependsOn] } : {}) })
    const timing = chatSendTimings.get(record.clientMessageId); if (timing) timing.enqueue = performance.now()
  }

  return {
    dispose: unregister,
    enqueue: (record) => put(record, record.state === 'uploading'),
    stageUpload: (record) => put(record, true),
    has: (id) => !!chatItem(id),
    async retry(id) {
      const item = chatItem(id)
      if (!item || item.state !== 'failed' || item.failure?.reason === 'dependency' || needsFile(item) || item.payload.operation?.kind === 'upload') return
      await outbox.retry(id)
    },
    async commitUpload(record) {
      const item = chatItem(record.clientMessageId)
      if (!item?.payload.uploading || item.state === 'failed') return false
      return !!await outbox.edit(record.clientMessageId, { ...sendOf(record, false), enqueuedAt: item.payload.enqueuedAt, preview: { ...record.preview, local_timeline: item.payload.preview?.local_timeline } })
    },
    async failUpload(id, _error, reason) {
      if (!chatItem(id)) return
      await outbox.fail(id, { reason: 'needs-file', message: reason ?? i18n.t('outbox.selectFileAgain', { ns: 'messaging' }) })
    },
    async resumeUpload(id) {
      const item = chatItem(id)
      if (!item || item.state !== 'failed' || item.failure?.reason === 'dependency') return false
      const kind = item.payload.operation?.kind
      if (!needsFile(item) && kind !== 'upload' && kind !== 'nativeAttachment') return false
      if (!await outbox.edit(id, { ...item.payload, operation: { kind: 'upload' }, uploading: true })) return false
      await outbox.retry(id)
      return true
    },
    async discard(id) {
      finishChatSendTiming(id)
      if (chatItem(id)) await outbox.discard(id)
    },
    async restore() {
      await outbox.loaded()
      const records: OutboxRecord[] = []
      for (const item of outbox.items() as OutboxItem<ChatSend>[]) {
        if (item.kind !== CHAT_MESSAGE) continue
        // An upload's bytes lived only in the run that was sending them: whatever it failed with then, now the file must
        // be selected again.
        const selectAgain = i18n.t('outbox.selectFileAgain', { ns: 'messaging' })
        if ((item.payload.uploading || needsFile(item)) && item.failure?.message !== selectAgain) await outbox.fail(item.id, { reason: 'needs-file', message: selectAgain })
        records.push(recordOf(chatItem(item.id) ?? item))
      }
      return records
    },
    pendingFor: (chatId, threadRootId) => (outbox.items() as OutboxItem<ChatSend>[])
      .filter((item) => item.kind === CHAT_MESSAGE && item.payload.chatId === chatId && (item.payload.payload.threadRootId ?? null) === threadRootId)
      .map(recordOf),
    delivered: async (id) => { await outbox.settled(id) },
  }
}
