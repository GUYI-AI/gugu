import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById, upsertMessageById } from '@gugu/core/shared/ui/messageListModels'

const at = (minute: number) => `2026-11-16T03:${String(minute).padStart(2, '0')}:00.000Z`
const row = (id: string, seq: number, minute: number): MessageItem => ({
  id, chat_id: 'chat', sender_user_id: 'sender', to_user_ids: null, seq, content: id, content_type: 'text',
  reply_to_message_id: null, retracted_at: null, created_at: at(minute),
  is_mine: true, delivered: seq > 0, delivery_status: null, local_send_state: null,
})
// A failed send as the outbox hands it over: with the slot it took when it was sent.
const failed = (id: string, afterSeq: number, minute: number): MessageItem => ({
  ...row(id, -1, minute), local_send_state: 'failed', local_timeline: { afterSeq, createdAt: at(minute) },
})
const ids = (rows: MessageItem[]) => rows.map(row => row.id)

describe('failed outgoing message positions', () => {
  it('keeps a failed message before a later delivered message', () => {
    let window = upsertMessageById([row('before', 10, 1)], failed('failed', 10, 2))
    window = upsertMessageById(window, row('later', 11, 3))
    expect(ids(window)).toEqual(['before', 'failed', 'later'])
  })

  it('places restored failures at the slots they were sent in', () => {
    const persisted = [row('before', 10, 1), row('later', 11, 4)]
    const restored = [failed('failed-2', 10, 3), failed('failed-1', 10, 2)]
    expect(ids(mergeMessagesById(persisted, restored, 'chat'))).toEqual(['before', 'failed-1', 'failed-2', 'later'])
  })

  it('keeps the same position through resend acknowledgement and subsequent body refreshes', () => {
    let window = upsertMessageById([row('before', 10, 1)], failed('failed', 10, 2))
    window = upsertMessageById(window, row('later', 11, 3))
    const acknowledged = row('failed', 12, 4)
    window = upsertMessageById(window, acknowledged)
    expect(ids(window)).toEqual(['before', 'failed', 'later'])
    expect(window.find(row => row.id === 'failed')).toMatchObject({ seq: 12, created_at: acknowledged.created_at, local_send_state: null })
    window = mergeMessagesById(window, [row('later', 11, 3), acknowledged, row('before', 10, 1)], 'chat')
    expect(ids(window)).toEqual(['before', 'failed', 'later'])
    expect(window.filter(row => row.id === 'failed')).toHaveLength(1)
  })

  it('keeps server sequence order for unrelated messages despite clock skew', () => {
    const first = row('first', 10, 4), second = row('second', 11, 1), third = row('third', 12, 2)
    expect(ids(mergeMessagesById([], [third, first, second], 'chat'))).toEqual(['first', 'second', 'third'])
  })

  it('puts an unsent row without a slot last, whatever its local clock says', () => {
    const pending = { ...row('pending', -1, 0), local_send_state: 'sending' as const }
    const result = mergeMessagesById([row('before', 10, 1), row('after', 11, 3)], [pending], 'chat')
    expect(ids(result)).toEqual(['before', 'after', 'pending'])
    expect(result.at(-1)).toBe(pending)
  })

  it('orders simultaneous local sends deterministically without changing server sequence numbers', () => {
    const earlier = failed('a', 10, 2), later = failed('b', 10, 2)
    const result = mergeMessagesById([row('before', 10, 1), row('after', 11, 3)], [later, earlier], 'chat')
    expect(ids(result)).toEqual(['before', 'a', 'b', 'after'])
    expect(result.map(row => row.seq)).toEqual([10, -1, -1, 11])
  })
})
