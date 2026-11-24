// #2548 内层侧栏「话题」:一个群 / 项目群自己的话题。
//   第二级(「全部 ›」)的次序和会话列表同一条:置顶的在前,再按最近活动。
//   · 第一级:最多 12 条(yangchichi msg:b3d2bd56,原 5 条太少),有未读也不突破(msg:616413ff:个人项目里话题多半没点开过,原来「有未读一律露」就全量展开了;msg:900d2e39「不超出」);
//     置顶的在前,再是有未读的,再按最近活动 —— 有未读的排到前面,不另外多露。
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention, compareChatsByActivityDesc, comparePinnedFirst } from '@gugu/core/shared/ui/chatModels'

/** 第一级最多露几条。 */
export const INNER_SIDEBAR_TOPIC_LIMIT = 12

/** 这个对话的话题,置顶的在前、再按最近活动(同会话列表);归档的不算(同话题菜单 topicPinGroups)。 */
export function topicsOfChat(chats: readonly ChatItem[], chatId: string): ChatItem[] {
  return chats
    .filter((chat) => chat.kind === 'topic' && chat.source_chat_id === chatId && chat.status !== 'archived')
    .sort((a, b) => comparePinnedFirst(a, b) || compareChatsByActivityDesc(a, b))
}

export type InnerSidebarTopicRows = {
  shown: ChatItem[]
  /** 第一级收起的条数(第二级为 0)。 */
  hidden: number
  /** 叫到我的合计(分区收起时标题旁那个数)。 */
  calling: number
}

/** `topics` 是 topicsOfChat 排好的(置顶的在前,再按最近活动)。 */
export function innerSidebarTopicRows(topics: readonly ChatItem[], { all }: { all: boolean }): InnerSidebarTopicRows {
  const calling = topics.reduce((sum, topic) => sum + chatAttention(topic).forYou, 0)
  if (all) return { shown: [...topics], hidden: 0, calling }
  const unreadFirst = [...topics].sort((a, b) => comparePinnedFirst(a, b) || Number(b.unread_count > 0) - Number(a.unread_count > 0))
  return { shown: unreadFirst.slice(0, INNER_SIDEBAR_TOPIC_LIMIT), hidden: Math.max(0, topics.length - INNER_SIDEBAR_TOPIC_LIMIT), calling }
}
