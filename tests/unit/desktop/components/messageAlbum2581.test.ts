import { describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { collapseSendGroups, newestDelivered } from '../../../../apps/desktop/src/components/chat/messageAlbum'
import { forwardToChats } from '../../../../apps/desktop/src/components/chat/forwardToChats'

// #2581 Files sent at once are one message: the list draws a send as one row, forwarding it keeps it one send.
function message(overrides: Partial<MessageItem>): MessageItem {
  return { id: 'm', chat_id: 'c', sender_user_id: 'u', to_user_ids: null, seq: 1, content: '[附件] a.png (image/png)', content_type: 'attachment',
    reply_to_message_id: null, retracted_at: null, created_at: '2026-11-13T00:00:00Z', reactions: [], ...overrides } as MessageItem
}
const inSend = (id: string, seq: number, extra: Partial<MessageItem> = {}) => message({ id, seq, send_group_id: 'g', send_group_size: 3, ...extra })
const rows = (messages: MessageItem[]) => messages.map((m) => ({ type: 'message' as const, message: m }))

describe('collapseSendGroups', () => {
  it('draws a send as its first row; the album holds its files in order', () => {
    const before = message({ id: 'x', seq: 1, content_type: 'text', content: 'hi' })
    const { rows: drawn, albums } = collapseSendGroups(rows([before, inSend('a', 2), inSend('b', 3), inSend('c', 4)]))
    expect(drawn.map((row) => row.message.id)).toEqual(['x', 'a'])
    expect(albums.get('a')?.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(albums.has('x')).toBe(false)
  })

  it('one failed file marks the send failed, retryable if any of them is; a sending file marks it sending', () => {
    const failed = collapseSendGroups(rows([inSend('a', 2), inSend('b', -1, { local_send_state: 'failed', local_send_error: 'quota', local_send_retryable: true }), inSend('c', 4)]))
    expect(failed.rows[0]!.message).toMatchObject({ id: 'a', local_send_state: 'failed', local_send_error: 'quota', local_send_retryable: true })
    const sending = collapseSendGroups(rows([inSend('a', 2), inSend('b', -1, { local_send_state: 'sending' })]))
    expect(sending.rows[0]!.message.local_send_state).toBe('sending')
  })

  it('leaves alone a file sent on its own, another sender’s send with the same group, and a send of which one row is here', () => {
    const lone = message({ id: 'l', seq: 1 })
    const theirs = inSend('t', 2, { sender_user_id: 'v' })
    const { rows: drawn, albums } = collapseSendGroups(rows([lone, inSend('a', 3), theirs]))
    expect(drawn.map((row) => row.message.id)).toEqual(['l', 'a', 't'])
    expect(albums.size).toBe(0)
  })

  it('marks a send read by the last of its files that reached the conversation', () => {
    expect(newestDelivered([inSend('a', 2), inSend('b', 5), inSend('c', -1)]).id).toBe('b')
  })
})

describe('forwarding a send', () => {
  it('files of one send land as one new send in each chat; a file forwarded alone is on its own', async () => {
    const forwardMessage = vi.fn(async () => {})
    const io = { forwardMessage, sendMessageToChat: vi.fn(async () => undefined), knownName: () => 'A', unknownName: '?' }
    const lone = message({ id: 'l', seq: 9, send_group_id: 'h', send_group_size: 2 })
    await forwardToChats([inSend('a', 2), inSend('b', 3), lone].map((m) => ({ kind: 'message' as const, message: m })), ['g1', 'g2'], { text: '', toUserIds: [] }, io)
    const calls = forwardMessage.mock.calls as unknown as Array<[MessageItem, string, { sendGroup?: { id: string; size: number } }?]>
    expect(calls.map(([m, chat]) => `${m.id}@${chat}`)).toEqual(['a@g1', 'b@g1', 'l@g1', 'a@g2', 'b@g2', 'l@g2'])
    const [a1, b1, l1, a2, b2] = calls.map((call) => call[2]?.sendGroup)
    expect(a1).toEqual({ id: expect.any(String), size: 2 })
    expect(b1).toEqual(a1)
    expect(l1).toBeUndefined()
    expect(a2!.id).not.toBe(a1!.id)
    expect(b2).toEqual(a2)
  })
})
