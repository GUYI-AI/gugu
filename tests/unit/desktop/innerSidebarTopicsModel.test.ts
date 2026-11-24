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

  it('pinned first, then unread, then most recent; All shows every one in the list order', () => {
    const topics = topicsOfChat([
      topic('recent', 100), topic('recent-2', 99), topic('recent-3', 98), topic('recent-4', 97), topic('recent-5', 96),
      topic('old-unread', 10, { unread_count: 3 }), topic('old-pinned', 5, { is_pinned: true }),
    ], 'g')
    expect(innerSidebarTopicRows(topics, { all: false }).shown.map((t) => t.id)).toEqual(['old-pinned', 'old-unread', 'recent', 'recent-2', 'recent-3', 'recent-4', 'recent-5'])
    expect(innerSidebarTopicRows(topics, { all: true }).shown.map((t) => t.id)).toEqual(['old-pinned', 'recent', 'recent-2', 'recent-3', 'recent-4', 'recent-5', 'old-unread'])
  })
})
