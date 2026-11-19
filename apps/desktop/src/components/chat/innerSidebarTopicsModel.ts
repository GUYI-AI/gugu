// #2548 内层侧栏「话题」:一个群 / 项目群自己的话题。
//   · 第一级:叫到我的(@ 我、@所有人、回复我的 —— chatAttention.forYou)一律露;其余按「有新消息的在前、再按最近活动」补满 5 条。
//   · 第二级(分区头的「全部 ›」):全部,同一个次序。
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention, compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'

/** 第一级最多露几条(叫到我的不受它限)。 */
export const INNER_SIDEBAR_TOPIC_LIMIT = 5

/** 这个对话的话题,最近活动的在前;归档的不算(同话题菜单 topicPinGroups)。 */
export function topicsOfChat(chats: readonly ChatItem[], chatId: string): ChatItem[] {
  return chats
    .filter((chat) => chat.kind === 'topic' && chat.source_chat_id === chatId && chat.status !== 'archived')
    .sort(compareChatsByActivityDesc)
}

const callsMe = (topic: ChatItem) => chatAttention(topic).forYou > 0
const hasNews = (topic: ChatItem) => topic.unread_count > 0 || topic.is_marked_unread === true
const rank = (topic: ChatItem) => (callsMe(topic) ? 2 : hasNews(topic) ? 1 : 0)

export type InnerSidebarTopicRows = {
  shown: ChatItem[]
  /** 第一级收起的条数(第二级为 0)。 */
  hidden: number
  /** 叫到我的合计(分区收起时标题旁那个数)。 */
  calling: number
}

/** `topics` 是 topicsOfChat 排好的(最近活动在前)。 */
export function innerSidebarTopicRows(topics: readonly ChatItem[], { all }: { all: boolean }): InnerSidebarTopicRows {
  // 稳定排序:同一档里保持最近活动的次序。
  const ranked = [...topics].sort((a, b) => rank(b) - rank(a))
  const calling = topics.reduce((sum, topic) => sum + chatAttention(topic).forYou, 0)
  if (all) return { shown: ranked, hidden: 0, calling }
  const room = Math.max(0, INNER_SIDEBAR_TOPIC_LIMIT - ranked.filter(callsMe).length)
  const rest = new Set(ranked.filter((topic) => !callsMe(topic)).slice(0, room))
  const shown = ranked.filter((topic) => callsMe(topic) || rest.has(topic))
  return { shown, hidden: ranked.length - shown.length, calling }
}
