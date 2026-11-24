import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'

export type SourceTopic = ChatItem & { kind: 'topic'; source_chat_id: string }

export function topicUnreadTotal(topics: readonly ChatItem[]): number {
  return topics.reduce((total, topic) => total + (topic.is_muted ? 0 : topic.unread_count), 0)
}

/** 话题里叫到你的总数:和项目行、通知同一个公式,免打扰的不算。 */
export function topicCallTotal(topics: readonly ChatItem[]): number {
  return topics.reduce((total, topic) => total + chatAttention(topic).askingYou, 0)
}

/** 话题菜单:同会话列表,置顶的在前、再按活跃;未读只挂角标,不挪位置。 */
export function topicMenuGroups({ pinned, others }: { pinned: readonly SourceTopic[]; others: readonly SourceTopic[] }) {
  return [pinned, others].filter(group => group.length > 0)
}

