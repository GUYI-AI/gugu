import { describe, expect, it } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ChatHistoryWindow } from '@/store/chatHistoryWindow'
import { maxMainlineSeq, MESSAGE_WINDOW, trimToMessageWindow } from '@/store/chatMessageWindow'

const row = (id: string, seq: number): MessageItem => ({ id, chat_id: 'chat', sender_user_id: 'sender', to_user_ids: null,
  seq, content: id, content_type: 'text', reply_to_message_id: null, retracted_at: null, created_at: '2026-11-16T00:00:00Z',
  is_mine: true, delivered: seq > 0, delivery_status: null, local_send_state: seq < 1 ? 'failed' : null })

describe('failed messages in bounded history windows', () => {
  it('does not move failed rows to the end when resetting or updating a window', () => {
    const window = new ChatHistoryWindow()
    const rows = [row('before', 10), row('failed', -1), row('later', 11)]
    window.reset('chat', rows)
    expect(window.getSnapshot().messages.map(row => row.id)).toEqual(['before', 'failed', 'later'])
    window.update(previous => [...previous, row('newest', 12)])
    expect(window.getSnapshot().messages.map(row => row.id)).toEqual(['before', 'failed', 'later', 'newest'])
  })

  it('retains actionable failures in their relative positions when a tail window is trimmed', () => {
    const failed = row('failed', -1)
    const rows = [row('before', 1), failed, ...Array.from({ length: 50 }, (_, index) => row(`later-${index}`, index + 2))]
    const trimmed = trimToMessageWindow(rows)
    expect(trimmed).toHaveLength(MESSAGE_WINDOW)
    expect(trimmed[0]).toBe(failed)
    expect(trimmed.at(-1)?.id).toBe('later-49')
    expect(maxMainlineSeq(trimmed)).toBe(51)
  })
})
