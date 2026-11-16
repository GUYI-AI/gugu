// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '@/lib/localSyncDb'
import { ackOutboxRecord, imSelectors, openImRepository, putOutboxRecord, type OutboxRecord } from '@/lib/imRepository'

const row = (id: string, seq: number, minute: number): MessageItem => ({ id, chat_id: 'chat', sender_user_id: 'sender', to_user_ids: null,
  seq, content: id, content_type: 'text', reply_to_message_id: null, retracted_at: null,
  created_at: `2026-11-16T00:${String(minute).padStart(2, '0')}:00.000Z`, is_mine: true, delivered: true, delivery_status: null })
const outbox = (): OutboxRecord => ({ clientMessageId: 'failed', chatId: 'chat', senderUserId: 'sender',
  payload: { content: 'failed', contentType: 'text', toUserIds: null, replyToMessageId: null,
    threadRootId: null, isThreadRoot: false, isWhisper: false }, state: 'failed', attempts: 3, lastError: 'network failure',
  enqueuedAt: '2026-11-16T00:02:00.000Z', updatedAt: '2026-11-16T00:03:00.000Z' })

describe('sender-device resend position persistence', () => {
  it('preserves the original slot across acknowledgement, reopening and a fresh authoritative body', async () => {
    const adapter = createMemoryLocalSyncDb()
    let repository = await openImRepository('sender', { adapter, storage: window.localStorage })
    await repository.transaction(tx => tx.putMessage(row('before', 10, 1)))
    const record = outbox()
    await putOutboxRecord(repository, record)
    await repository.transaction(tx => tx.putMessage(row('later', 11, 3)))
    const acknowledged = await ackOutboxRecord(repository, 'failed', row('failed', 12, 4))
    expect(acknowledged.seq).toBe(12)
    expect(acknowledged.created_at).toBe('2026-11-16T00:04:00.000Z')
    expect(repository.snapshot().outbox).toHaveLength(0)
    repository.close()
    repository = await openImRepository('sender', { adapter, storage: window.localStorage })
    await repository.transaction(tx => tx.putMessage(row('failed', 12, 4)))
    const rows = imSelectors.messagesForStream('main:chat')(repository.snapshot())
    expect(rows.map(row => row.id)).toEqual(['before', 'failed', 'later'])
    expect(rows.map(row => row.seq)).toEqual([10, 12, 11])
    repository.close()
  })

  it('uses the observed sequence anchor even when the sending device clock is behind', async () => {
    const repository = await openImRepository('sender', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await repository.transaction(tx => tx.putMessage(row('before', 10, 5)))
    const record = outbox()
    await putOutboxRecord(repository, record)
    await repository.transaction(tx => tx.putMessage(row('later', 11, 6)))
    await ackOutboxRecord(repository, record.clientMessageId, row('failed', 12, 7))
    expect(imSelectors.messagesForChat('chat')(repository.snapshot()).map(row => row.id)).toEqual(['before', 'failed', 'later'])
    repository.close()
  })

  it('recovers an older failed outbox entry without replacing its original creation position', async () => {
    const repository = await openImRepository('sender', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    const record = outbox()
    await repository.transaction(tx => { tx.putMessage(row('before', 10, 1)); tx.putOutbox(record); tx.putMessage(row('later', 11, 3)) })
    await putOutboxRecord(repository, { ...record, state: 'pending' })
    await ackOutboxRecord(repository, record.clientMessageId, row('failed', 12, 4))
    expect(imSelectors.messagesForChat('chat')(repository.snapshot()).map(row => row.id)).toEqual(['before', 'failed', 'later'])
    repository.close()
  })
})
