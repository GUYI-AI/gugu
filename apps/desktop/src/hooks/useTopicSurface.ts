// 聊天区的「话题」这一面:锚点卡数据、从消息开话题、话题线追更。
//
// 话题是一条真的 chat,点它就把主会话换成它(和点群、点私聊同一条路:openLinkTarget → openChatTarget)。
// ❌ 不另开分栏/右栏 —— 纠正清单 #62「点话题 = 换主会话,不开在右侧栏」。
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ChatItem, MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import type { AccountRevisionEvent, AccountRevisionListener } from '@/lib/accountRevisionCoordinator'
import { topicService } from '@/lib/topics'
import { useChatStore } from '@/store/chatContext'
import { topicsSourceChatId, useTopicsOfChat } from './useTopics'
import { rendererLogger } from '@/lib/log'
import { topicNameFromMessage } from '@/components/chat/topicAnchorModels'
import { openLinkTarget } from '@/lib/guguLinks'

const topicSurfaceLog = rendererLogger('chat/topic-surface')

/** Topics open as the main conversation, the same way any chat does. */
export function openTopicChat(chatId: string): void {
  openLinkTarget({ kind: 'chat', chatId }).catch((error: unknown) => topicSurfaceLog.error({ error, chatId }, 'open topic failed'))
}

type UseTopicSurfaceArgs = {
  /** 当前打开的那条线。它自己是话题时,读的是来源线的话题清单(手机的话题条、追更都要),但不长锚点卡。 */
  chat: Pick<ChatItem, 'id' | 'kind' | 'source_chat_id'> | null | undefined
  messages: readonly Pick<MessageItem, 'id' | 'content' | 'content_type' | 'seq' | 'created_at'>[]
  /** The open line has nothing newer to page in: only then is its tail its server tail. */
  lineSettled: boolean
  refreshLine: (chatId: string) => Promise<unknown>
  /** 开不出话题时叫一声(必填:静默失败比报错难查)。 */
  onCreateFailed: (error: unknown) => void
  subscribeAccountRevision: (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void
}

export type TopicSurface = {
  /** 这条线上长出来的话题,按来源消息分组 —— 锚点卡读它。 */
  anchorsByMessageId: Map<string, TopicSummary[]> | null
  /** The source line's topics (the line itself, or a topic's source). */
  topics: TopicSummary[]
  topicsReady: boolean
  reloadTopics: () => void
  /** 从一条消息开一条话题:建完直接换成主会话,这就是 spec 的「建立是一步」。 */
  openTopicFromMessage: (sourceMessageId: string) => Promise<void>
}

export function useTopicSurface({ chat, messages, lineSettled, refreshLine, subscribeAccountRevision, onCreateFailed }: UseTopicSurfaceArgs): TopicSurface {
  const { createTopic } = useChatStore('createTopic')
  const chatId = chat?.id ?? null
  const topicChatId = chat?.kind === 'topic' ? chat.id : null
  const sourceMessages = useRef(messages)
  sourceMessages.current = messages
  const onCreateFailedRef = useRef(onCreateFailed)
  onCreateFailedRef.current = onCreateFailed
  // 清单只有一个属主:useTopicsOfChat。锚点卡与顶栏话题面板读的是同一份,❌ 不各拉各的。
  const { topics: read, bySourceMessageId, reload: reloadTopics } = useTopicsOfChat(
    topicChatId ? chat?.source_chat_id ?? null : topicsSourceChatId(chat),
    subscribeAccountRevision,
  )
  const topics = useMemo(() => read ?? [], [read])

  // message_created for a topic row reaches only the topic's members; every source-line member gets the source
  // chat_changed that re-reads this topic in `topics`. So the open topic catches up to its own summary whenever the
  // summary is newer than the line's tail -- one rule for whoever is reading, member or not.
  const summaryAt = Date.parse(topics.find((summary) => summary.chat_id === topicChatId)?.last_message_at ?? '')
  // Unsent rows sit at their send-time slot or last (orderMessages), so the last confirmed row is the line's server tail.
  const tail = messages.findLast((row) => row.seq > 0)
  const lineAt = tail ? Date.parse(tail.created_at) : -Infinity
  useEffect(() => {
    if (!topicChatId || !lineSettled || !(summaryAt > lineAt)) return
    refreshLine(topicChatId).catch((error: unknown) => topicSurfaceLog.error({ error, topicChatId }, 'topic catch-up failed'))
  }, [topicChatId, summaryAt, lineAt, lineSettled, refreshLine])

  const openTopicFromMessage = useCallback(
    async (sourceMessageId: string) => {
      if (!chatId) return
      try {
        const source = sourceMessages.current.find((message) => message.id === sourceMessageId)
        if (!source) throw new Error('Topic source message is not in the current message window')
        if (source.content_type === 'card' && parseComposerCard(source.content)?.type === 'task') {
          const existing = (await topicService.listTopicsOfChat(chatId)).find((topic) => topic.source_message_id === sourceMessageId)
          if (existing) { openTopicChat(existing.chat_id); return }
        }
        const created = await createTopic({
          sourceChatId: chatId,
          sourceMessageId,
          // 任务卡上开的话题(手机点卡、老卡还没有话题时)叫任务那句话,❌ 落成服务端的默认名。
          name: source.content_type === 'text' ? topicNameFromMessage(source.content)
            : source.content_type === 'card' ? topicNameFromMessage(parseComposerCard(source.content)?.text) : null,
        })
        if (!created) return // retained outbox failure already exposes retry/discard
        openTopicChat(created.chat_id)
      } catch (error) {
        // fail loud:开不出来必须当场告诉用户。原因进日志,文案只留他能照做的下一步。
        topicSurfaceLog.error({ error, chatId, sourceMessageId }, 'open topic failed')
        onCreateFailedRef.current(error)
      }
    },
    [chatId, createTopic],
  )

  return {
    anchorsByMessageId: topicChatId ? null : bySourceMessageId,
    topics,
    topicsReady: read !== null,
    reloadTopics,
    openTopicFromMessage,
  }
}
