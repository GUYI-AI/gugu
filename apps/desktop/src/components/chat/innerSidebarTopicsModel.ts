// #2548 内层侧栏「话题」:一个群 / 项目群自己的话题。
//   次序和会话列表同一条:置顶的在前,再按最近活动。未读只挂角标,不挪位置 —— 点开读完,它还在原处。
//   · 第一级:这个次序的前 6 条(owner msg:247795d5「默认显示的有点多了,收缩一点」,原 12 条;yangchichi msg:b3d2bd56 嫌 5 条太少);有未读也不突破(msg:616413ff、msg:900d2e39「不超出」)。
//   · 第二级(「全部 ›」):全部,同一个次序。
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention, compareChatsByActivityDesc, comparePinnedFirst } from '@gugu/core/shared/ui/chatModels'

/** 第一级最多露几条。 */
export const INNER_SIDEBAR_TOPIC_LIMIT = 6

/** 这个对话的话题,置顶的在前、再按最近活动(同会话列表);归档的不算。群页头的话题菜单用的也是这一份(useChatTopicPins)。 */
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
  return { shown: topics.slice(0, INNER_SIDEBAR_TOPIC_LIMIT), hidden: Math.max(0, topics.length - INNER_SIDEBAR_TOPIC_LIMIT), calling }
}
