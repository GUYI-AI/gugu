import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { INNER_SIDEBAR_TOPIC_LIMIT, innerSidebarTopicRows, topicsOfChat } from '@/components/chat/innerSidebarTopicsModel'

const topic = (id: string, at: number, extra: Partial<ChatItem> = {}) =>
  ({ id, kind: 'topic', source_chat_id: 'g', status: 'active', unread_count: 0, is_pinned: false, last_message_at: new Date(at * 1000).toISOString(), ...extra }) as ChatItem

describe('inner sidebar topics, level one', () => {
  it('never shows more than the limit, even when every topic is unread (a personal project nobody opened)', () => {
    const topics = topicsOfChat(Array.from({ length: 15 }, (_, i) => topic(`t${i}`, 100 - i, { unread_count: 1 })), 'g')
    const rows = innerSidebarTopicRows(topics, { all: false })
    expect(rows.shown).toHaveLength(INNER_SIDEBAR_TOPIC_LIMIT)
    expect(rows.hidden).toBe(15 - INNER_SIDEBAR_TOPIC_LIMIT)
  })

  it('pinned first, then most recent, in both levels: unread only marks a topic, it never moves one (reading it leaves it in place)', () => {
    const chats = [
      topic('recent', 100), topic('recent-2', 99, { unread_count: 2 }), topic('recent-3', 98),
      topic('old-unread', 10, { unread_count: 3 }), topic('old-pinned', 5, { is_pinned: true }),
    ]
    const order = ['old-pinned', 'recent', 'recent-2', 'recent-3', 'old-unread']
    const levelOne = (list: ChatItem[]) => innerSidebarTopicRows(topicsOfChat(list, 'g'), { all: false }).shown.map((t) => t.id)
    expect(levelOne(chats)).toEqual(order)
    expect(innerSidebarTopicRows(topicsOfChat(chats, 'g'), { all: true }).shown.map((t) => t.id)).toEqual(order)
    expect(levelOne(chats.map((t) => ({ ...t, unread_count: 0 }))), 'after reading them all').toEqual(order)
  })
})
