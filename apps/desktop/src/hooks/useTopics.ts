// @@@5856 一条线上长出来的话题清单 —— product spec。
//
// 只有一个数据源:topicService.listTopicsOfChat。锚点卡(挂在来源消息底下)和顶栏话题面板
// 共用这一份,❌ 不许各拉各的 —— 两份就会出现「锚点卡说 3 条、面板说 2 条」。
//
// 可见继承来源、参与靠说话:这个 hook 只负责把服务端算好的 is_participant 端上来,
// ❌ 不在客户端二次判断谁看得见谁被通知(那归 RLS 与数据库触发器,客户端再判一遍就是第二个属主)。
import { useCallback, useEffect, useMemo } from 'react'
import { replica, useReplica } from '../lib/replica'
import type { ChatItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { topicService } from '../lib/topics'
import { rendererLogger } from '../lib/log'
import { useAuth } from '../store/auth'
import { ingestMessages, localMessageQueries } from '../lib/messageIngest'
import { readRevisionResourceKey, type AccountRevisionEvent, type AccountRevisionListener } from '../lib/accountRevisionCoordinator'

const topicsLog = rendererLogger('chat/topics')


export interface UseTopicsOfChatResult {
  /** null until read (`loading`). */
  topics: TopicSummary[] | null
  /** 锚点卡按来源消息分组:一条来源消息可能长出多条话题,所以值是数组而非单条。 */
  bySourceMessageId: Map<string, TopicSummary[]>
  loading: boolean
  error: string | null
  /** 开完一条话题后调它,让来源消息底下的锚点卡当场长出来。 */
  reload: () => void
}

/**
 * 单层不嵌套的守卫做成一个纯函数,而不是藏在 hook 里 —— hook 只拿得到一个 id,判断不出
 * 这条会话是不是话题本身。调用点 `useTopicsOfChat(topicsSourceChatId(activeChat))` 即可:
 * 话题上不再开话题(product spec「必须有来源」),所以话题会话直接给 null、不发请求。
 */
export function topicsSourceChatId(chat: Pick<ChatItem, 'id' | 'kind'> | null | undefined): string | null {
  if (!chat) return null
  if (chat.kind === 'topic') return null
  return chat.id
}

type SubscribeAccountRevision = (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void

/** Read topics of a line and record their access facts locally, as of the local revision before the read. */
async function readTopics(userId: string | null, sourceChatId: string, topicChatId?: string) {
  const revision = userId ? await localMessageQueries()?.throughRevision(userId) : null
  const rows = await topicService.listTopicsOfChat(sourceChatId, topicChatId)
  const record = async () => {
    if (userId) await ingestMessages(userId, { writes: rows.map(topic => ({ type: 'chatAccess', access: {
      chatId: topic.chat_id, sourceChatId, ownMember: topic.is_participant, revision: revision ?? '0',
    } })), revisions: [] })
  }
  return { rows, record }
}

const lastActivity = (topic: TopicSummary) => (topic.last_message_at ? Date.parse(topic.last_message_at) : -Infinity)

/** One topic's fresh summary in the list; absent means it is gone (archived, or no longer visible). */
function withTopic(topics: TopicSummary[], topicChatId: string, row: TopicSummary | undefined): TopicSummary[] {
  const rest = topics.filter((topic) => topic.chat_id !== topicChatId)
  if (!row) return rest.length === topics.length ? topics : rest
  // The server's order: latest activity first. Array sort is stable, so the fresh row leads its ties.
  return [row, ...rest].sort((a, b) => lastActivity(b) - lastActivity(a))
}

/**
 * The topics of a line (account replica). Each read records their access facts locally, as of the local revision
 * before the read. fail loud:话题列不出来就说列不出来,❌ 不许静默当成「这条线上没有话题」—— 那会让来源消息底下的锚点卡
 * 凭空消失,用户以为话题被删了。
 */
export const topicsOfChat = replica({
  name: 'topicsOfChat',
  scope: 'account',
  read: async (owner: string, sourceChatId: string): Promise<TopicSummary[]> => {
    try {
      const { rows, record } = await readTopics(owner, sourceChatId)
      await record()
      return rows
    } catch (error) {
      topicsLog.error({ error, sourceChatId }, 'list topics of chat failed')
      throw error
    }
  },
})

/**
 * Where a topic was opened from, for its split header (@@@5856): `readable` with the source line's preview, `gone`
 * (deleted), or `unreadable` (the source is there but not for this reader — ❌ said as deleted). No push: read on open,
 * kept a while for switching back. A failed read is an error reading (❌ "deleted").
 */
export const topicSource = replica({
  name: 'topicSource',
  scope: 'account',
  read: async (_owner: string, topicChatId: string) => {
    try {
      return await topicService.getSourceState(topicChatId)
    } catch (error) {
      topicsLog.error({ error, topicChatId }, 'topic source message preview failed')
      throw error
    }
  },
  fresh: 0,
  keep: 30 * 60_000,
})

/**
 * @param subscribeAccountRevision 订阅 chat_changed。话题的新建、改名、归档、成员变化和新消息,服务端都会给来源线的
 *   每个成员发一条 chat_changed,entity_id 是那条话题(gugu-supabase 20261106120000)。这里只重读那一条 ——
 *   否则对端要重开这条线才看得见新话题(#1588)。来源线自己的 chat_changed(每条消息一次)没有 entity_id,与这份清单无关。
 */
export function useTopicsOfChat(
  sourceChatId: string | null,
  subscribeAccountRevision?: SubscribeAccountRevision,
): UseTopicsOfChatResult {
  const userId = useAuth().user?.id ?? null
  // Keyed by the line: switching lines never hands out the previous line's topics, and a line seen before has its topics
  // on the first frame (#6519) while it is read again.
  const reading = useReplica(topicsOfChat, sourceChatId ? [sourceChatId] : null)
  // null until the line's topics are read: no anchor card and no topic list yet, ❌ an empty list that says「没有话题」.
  const topics = reading.state === 'value' ? reading.value : null
  const failure = reading.state === 'error' ? reading.error : reading.state === 'value' ? reading.error : null
  const loading = !!sourceChatId && reading.state === 'unknown'

  const reload = useCallback(() => { if (sourceChatId) void topicsOfChat.refresh(sourceChatId) }, [sourceChatId])

  useEffect(() => {
    if (!sourceChatId || !subscribeAccountRevision) return
    let active = true
    // A later read of the same topic supersedes an earlier one still in flight.
    const latest = new Map<string, number>()
    let reads = 0
    const refresh = async (topicChatId: string) => {
      const read = ++reads
      latest.set(topicChatId, read)
      const current = () => active && latest.get(topicChatId) === read
      // Bound before the awaits: a topic read for this account lands in it (❌ the next one's line).
      const entry = topicsOfChat.at(sourceChatId)
      try {
        const { rows, record } = await readTopics(userId, sourceChatId, topicChatId)
        if (!current()) return
        await record()
        if (!current()) return
        entry.set((shown) => shown ? withTopic(shown, topicChatId, rows[0]) : shown)
      } catch (err) {
        if (!current()) return
        // One topic could not be read: read the whole line again (I1), its failure is the line's reading.
        topicsLog.error({ error: err, sourceChatId, topicChatId }, 'read topic failed; reading the line again')
        reload()
      }
    }
    const unsubscribe = subscribeAccountRevision('chat_changed', (operations) => {
      for (const operation of operations) {
        const { chatId, entityId } = readRevisionResourceKey(operation.payload, 'chat_changed')
        if (chatId !== sourceChatId || !entityId) continue
        // The whole-line read still in flight may predate this change: read the line again instead (a one-moment look
        // at the replica's own entry, outside rendering).
        if (topicsOfChat.isFetching(sourceChatId)) reload()
        else void refresh(entityId)
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [sourceChatId, subscribeAccountRevision, reload, userId])

  const bySourceMessageId = useMemo(() => {
    const index = new Map<string, TopicSummary[]>()
    // @@@reading-default - topics not read: no anchor card for any message yet (the surface's decision, useTopicSurface)
    for (const topic of topics ?? []) {
      const bucket = index.get(topic.source_message_id)
      if (bucket) bucket.push(topic)
      else index.set(topic.source_message_id, [topic])
    }
    return index
  }, [topics])

  return { topics, bySourceMessageId, loading, error: failure ? failure.message ?? String(failure) : null, reload }
}
