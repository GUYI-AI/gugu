// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '@/lib/localSyncDb'
import { ackOutboxRecord, openImRepository, putOutboxRecord, type OutboxRecord } from '@/lib/imRepository'
import { ingestMessages } from '@/lib/messageIngest'
import { clearMessageWindows, messageWindow } from '@/lib/messageWindows'

const row = (id: string, seq: number, minute: number): MessageItem => ({ id, chat_id: 'chat', sender_user_id: 'sender', to_user_ids: null,
  seq, content: id, content_type: 'text', reply_to_message_id: null, retracted_at: null,
  created_at: `2026-11-16T00:${String(minute).padStart(2, '0')}:00.000Z`, is_mine: true, delivered: true, delivery_status: null })
const outbox = (): OutboxRecord => ({ clientMessageId: 'failed', chatId: 'chat', senderUserId: 'sender',
  payload: { content: 'failed', contentType: 'text', toUserIds: null, replyToMessageId: null,
    threadRootId: null, isThreadRoot: false, isWhisper: false }, state: 'failed', attempts: 3, lastError: 'network failure',
  enqueuedAt: '2026-11-16T00:02:00.000Z', updatedAt: '2026-11-16T00:03:00.000Z' })
const put = (message: MessageItem) => ingestMessages('sender', { writes: [{ type: 'put', message }], revisions: [] })
const shown = () => messageWindow('sender', 'chat')?.map(item => item.id)

afterEach(() => clearMessageWindows('sender'))

describe('sender-device resend position persistence', () => {
  it('preserves the original slot across acknowledgement, reopening and a fresh authoritative body', async () => {
    const adapter = createMemoryLocalSyncDb()
    let repository = await openImRepository('sender', { adapter, storage: window.localStorage })
    await put(row('before', 10, 1))
    await putOutboxRecord(repository, outbox())
    await put(row('later', 11, 3))
    const acknowledged = await ackOutboxRecord(repository, 'failed', row('failed', 12, 4))
    expect(acknowledged.seq).toBe(12)
    expect(acknowledged.created_at).toBe('2026-11-16T00:04:00.000Z')
    expect(repository.snapshot().outbox).toHaveLength(0)
    repository.close()
    clearMessageWindows('sender')
    repository = await openImRepository('sender', { adapter, storage: window.localStorage })
    // A fresh server body carries no position; the stored row keeps the sender's slot.
    await put(row('failed', 12, 4))
    expect(shown()).toEqual(['before', 'failed', 'later'])
    repository.close()
  })

  it('uses the observed sequence anchor even when the sending device clock is behind', async () => {
    const repository = await openImRepository('sender', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await put(row('before', 10, 5))
    const record = outbox()
    await putOutboxRecord(repository, record)
    await put(row('later', 11, 6))
    await ackOutboxRecord(repository, record.clientMessageId, row('failed', 12, 7))
    expect(shown()).toEqual(['before', 'failed', 'later'])
    repository.close()
  })

  it('slots an outbox entry saved without a position after what the conversation shows when it is resent', async () => {
    const repository = await openImRepository('sender', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    const record = outbox()
    await put(row('before', 10, 1))
    await repository.transaction(tx => tx.putOutbox(record))
    await put(row('later', 11, 3))
    await putOutboxRecord(repository, { ...record, state: 'pending' })
    await ackOutboxRecord(repository, record.clientMessageId, row('failed', 12, 4))
    // No clock comparison: a record without a slot gets one from the rows on screen, like a new send.
    expect(shown()).toEqual(['before', 'later', 'failed'])
    repository.close()
  })
})
