import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { topicsOfChat } from '@/components/chat/innerSidebarTopicsModel'

const topic = (id: string, at: number, extra: Partial<ChatItem> = {}) =>
  ({ id, kind: 'topic', source_chat_id: 'g', status: 'active', unread_count: 0, is_pinned: false, last_message_at: new Date(at * 1000).toISOString(), ...extra }) as ChatItem

describe('inner sidebar topics, level one', () => {
  it('keeps topics beyond the default viewport available in order, including all unread ones', () => {
    const topics = Array.from({ length: 15 }, (_, i) => topic(`t${i}`, 100 - i, { unread_count: 1 }))
    expect(topicsOfChat(topics, 'g')).toEqual(topics)
  })

  it('pinned first, then most recent, in both levels: unread only marks a topic, it never moves one (reading it leaves it in place)', () => {
    const chats = [
      topic('recent', 100), topic('recent-2', 99, { unread_count: 2 }), topic('recent-3', 98),
      topic('old-unread', 10, { unread_count: 3 }), topic('old-pinned', 5, { is_pinned: true }),
    ]
    const order = ['old-pinned', 'recent', 'recent-2', 'recent-3', 'old-unread']
    const levelOne = (list: ChatItem[]) => topicsOfChat(list, 'g').map((t) => t.id)
    expect(levelOne(chats)).toEqual(order)
    expect(levelOne(chats.map((t) => ({ ...t, unread_count: 0 }))), 'after reading them all').toEqual(order)
  })
})
