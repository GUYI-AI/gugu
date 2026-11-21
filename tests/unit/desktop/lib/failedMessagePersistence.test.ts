// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '@/lib/localSyncDb'
import { confirmSentMessage, imSelectors, openImRepository, outboxMessagePosition, type OutboxRecord } from '@/lib/imRepository'

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
    const record = outboxMessagePosition(repository, outbox())
    await repository.transaction(tx => tx.putMessage(row('later', 11, 3)))
    const acknowledged = await confirmSentMessage(repository, record, row('failed', 12, 4))
    expect(acknowledged.seq).toBe(12)
    expect(acknowledged.created_at).toBe('2026-11-16T00:04:00.000Z')
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
    const record = outboxMessagePosition(repository, outbox())
    await repository.transaction(tx => tx.putMessage(row('later', 11, 6)))
    await confirmSentMessage(repository, record, row('failed', 12, 7))
    expect(imSelectors.messagesForChat('chat')(repository.snapshot()).map(row => row.id)).toEqual(['before', 'failed', 'later'])
    repository.close()
  })

  it('a failed entry sent again keeps its original creation position', async () => {
    const repository = await openImRepository('sender', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await repository.transaction(tx => tx.putMessage(row('before', 10, 1)))
    const record = outboxMessagePosition(repository, outbox())
    await repository.transaction(tx => tx.putMessage(row('later', 11, 3)))
    // Queued again (a retry, an import from an older build): the place it was given first stays.
    const again = outboxMessagePosition(repository, { ...record, state: 'pending' })
    expect(again.preview?.local_timeline).toEqual(record.preview?.local_timeline)
    await confirmSentMessage(repository, again, row('failed', 12, 4))
    expect(imSelectors.messagesForChat('chat')(repository.snapshot()).map(row => row.id)).toEqual(['before', 'failed', 'later'])
    repository.close()
  })

  it('slots an outbox entry saved without a position after what the conversation shows when it is resent', async () => {
    const repository = await openImRepository('sender', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await repository.transaction(tx => { tx.putMessage(row('before', 10, 1)); tx.putMessage(row('later', 11, 3)) })
    const record = outboxMessagePosition(repository, { ...outbox(), state: 'pending' })
    await confirmSentMessage(repository, record, row('failed', 12, 4))
    // No clock comparison: a record without a slot gets one from the rows on screen, like a new send.
    expect(imSelectors.messagesForChat('chat')(repository.snapshot()).map(row => row.id)).toEqual(['before', 'later', 'failed'])
    repository.close()
  })
})
