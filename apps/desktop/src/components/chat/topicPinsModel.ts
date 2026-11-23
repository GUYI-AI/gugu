import type { ChatItem } from '@gugu/core/shared/types/chat'
import { openTopicChat } from '@/hooks/useTopicSurface'
import { chatAttention, compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'

export type SourceTopic = ChatItem & { kind: 'topic'; source_chat_id: string }

export function topicPinGroups(chats: readonly ChatItem[], chatId: string | null, ids: readonly string[]) {
  const topics = chats.filter((chat): chat is SourceTopic => chatId !== null && chat.kind === 'topic' && chat.source_chat_id === chatId && chat.status !== 'archived')
  const byId = new Map(topics.map((topic) => [topic.id, topic]))
  const pinned = ids.flatMap((id) => byId.get(id) ?? [])
  const others = topics.filter((topic) => !ids.includes(topic.id)).sort(compareChatsByActivityDesc)
  return { topics, pinned, others }
}

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

export function openPinnedTopic(topic: SourceTopic) {
  openTopicChat(topic.id)
}
