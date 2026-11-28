import { describe, expect, it } from 'vitest'
import { nextChatId } from '../../../apps/desktop/src/components/chat-list-keyboard-nav'
import { chatLineCalls, chatLineIsUnread } from '../../../apps/desktop/src/lib/chatLineUnread'
import type { ChatItem } from '@gugu/core/shared/types/chat'

describe('visible conversation order', () => {
  const ids = ['first', 'read', 'middle', 'last']
  const accepts = (id: string) => id === 'first' || id === 'last'
  it('skips the selected row and read rows in either direction', () => {
    expect(nextChatId(ids, 'first', 1, accepts)).toBe('last')
    expect(nextChatId(ids, 'last', -1, accepts)).toBe('first')
  })
  it('starts at the appropriate end for an absent selection and never wraps', () => {
    expect(nextChatId(ids, null, 1, accepts)).toBe('first')
    expect(nextChatId(ids, 'hidden', -1, accepts)).toBe('last')
    expect(nextChatId(ids, 'last', 1, accepts)).toBeNull()
    expect(nextChatId(ids, 'first', -1, accepts)).toBeNull()
    expect(nextChatId(ids, null, 1, () => false)).toBeNull()
    expect(nextChatId([], null, -1)).toBeNull()
  })
})

describe('unread conversation rows', () => {
  const row: ChatItem = {
    id: 'group', kind: 'group', status: 'active', name: 'Group', created_at: '2026-01-01T00:00:00Z',
    last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null,
    last_read_seq: 0, next_message_seq: 1, notification_level: 'all', is_muted: true,
  }
  it('includes manual marks and ordinary unread news even in a muted conversation', () => {
    expect(chatLineIsUnread(row, 0)).toBe(false)
    expect(chatLineIsUnread({ ...row, is_marked_unread: true }, 0)).toBe(true)
    expect(chatLineIsUnread({ ...row, unread_count: 2 }, 0)).toBe(true)
  })
  it('counts a topic call on its source row, while unaddressed topic news stays in the topic', () => {
    const topic: ChatItem = { ...row, id: 'topic', kind: 'topic', source_chat_id: row.id, unread_count: 2 }
    for (const addressed of [0, 1]) {
      topic.unread_locator = {
        stream_id: 'topic-main', stream_kind: 'main', thread_root_id: null, message_id: null, message_seq: null,
        unread_count: 2, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false,
      }
      const calls = chatLineCalls([row, topic]).get(row.id) ?? 0
      expect(chatLineIsUnread(row, calls)).toBe(addressed > 0)
    }
  })
})
