// #2548 内层侧栏「话题」:一个群 / 项目群自己的话题,次序与条数规则就是聊天列表把话题嵌在群下面时那一套
// (chatListTopicNesting:最近活动的在前;第一级只露最近几条 + 有未读的,其余收起),❌ 另定一套。
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { compareChatsByActivityDesc, isSunkTopic } from '@gugu/core/shared/ui/chatModels'
import { splitSunkTopics, TOPIC_SUBROW_LIMIT } from '../chatListTopicNesting'

/** 这个对话的话题,最近活动的在前;归档的不算(同话题菜单 topicPinGroups)。 */
export function topicsOfChat(chats: readonly ChatItem[], chatId: string): ChatItem[] {
  return chats
    .filter((chat) => chat.kind === 'topic' && chat.source_chat_id === chatId && chat.status !== 'archived')
    .sort(compareChatsByActivityDesc)
}

/** 沉降判据(静了太久、没有未读、没置顶 / 标未读的):第一级把它们收起来。行与分区头读同一个。 */
export const topicIsSunkAt = (now: number) => (topic: ChatItem): boolean => isSunkTopic(topic, now)

/** 第一级露哪些、收起哪些;`all` = 第二级,全部露出。 */
export function innerSidebarTopicLevels(
  topics: readonly ChatItem[],
  now: number,
  all: boolean,
): { shown: ChatItem[]; hidden: ChatItem[] } {
  const { live, sunk } = splitSunkTopics(topics, topicIsSunkAt(now), TOPIC_SUBROW_LIMIT, all)
  return { shown: live, hidden: sunk }
}
