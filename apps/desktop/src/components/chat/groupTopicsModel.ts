import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'

export function topicUnreadTotal(topics: readonly ChatItem[]): number {
  return topics.reduce((total, topic) => total + (topic.is_muted ? 0 : topic.unread_count), 0)
}

/** 话题里叫到你的总数:和项目行、通知同一个公式,免打扰的不算。 */
export function topicCallTotal(topics: readonly ChatItem[]): number {
  return topics.reduce((total, topic) => total + chatAttention(topic).askingYou, 0)
}
