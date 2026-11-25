import type { ChatItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { chatAttention, compareByRecentActivity, comparePinnedFirst } from '@gugu/core/shared/ui/chatModels'
import { chatLineNews } from '@/lib/chatLineUnread'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'

export function phoneTopicsWithPins(topics: readonly TopicSummary[], chatsById: ReadonlyMap<string, ChatItem>) {
  return topics.map(topic => {
    const chat = chatsById.get(topic.chat_id)
    return { ...topic, is_pinned: topic.is_participant && chat ? Boolean(chat.is_pinned) : undefined }
  }).sort(comparePinnedFirst)
}

/** Each row's mark follows the chat-list rule: calls you (red @N, chatAttention.callsYou), else news (grey dot). */
export function roomTopicChoices(chatId: string, topics: readonly TopicSummary[], chats: readonly ChatItem[]) {
  const byId = new Map(chats.map(chat => [chat.id, chat]))
  const asking = (id: string) => { const chat = byId.get(id); return chat ? chatAttention(chat).askingYou : 0 }
  const mark = (id: string) => {
    const chat = byId.get(id)
    const calls = chat ? chatAttention(chat).callsYou : 0
    return { calls, news: !!chat && chatLineNews(chat, calls) }
  }
  const main = mark(chatId)
  const rows = phoneTopicsWithPins(topics, byId).sort((a, b) => Number(asking(b.chat_id) > 0) - Number(asking(a.chat_id) > 0))
    .map(topic => ({ ...topic, ...mark(topic.chat_id) }))
  const all = [main, ...rows]
  return {
    main,
    topics: rows,
    dot: all.some(row => row.calls > 0) ? 'call' as const : all.some(row => row.news) ? 'news' as const : undefined,
  }
}

/** This entry never creates an Agent DM when its task session cannot be opened. */
export function roomAgentEntry(profile: Pick<MemberProfileCardModel, 'type' | 'ownerUserId'>, userId: string | null, hasSession: boolean) {
  return profile.type === 'agent' && !!userId && profile.ownerUserId === userId && hasSession ? 'session' : 'profile'
}

/**
 * The Agents sheet's order, the same as the desktop Agents column, chats and topics (compareByRecentActivity): the last
 * session activity first, else when the agent was made, then id (`activityMs`, useAgentActivityMs). No status tiers:
 * status is the avatar badge and the row text, never the position.
 */
export function roomAgentsByRecentActivity<T extends { id: string }>(agents: readonly T[], activityMs: (id: string) => number): T[] {
  const stamp = (agent: T) => ({ id: agent.id, activityMs: activityMs(agent.id) })
  return [...agents].sort((a, b) => compareByRecentActivity(stamp(a), stamp(b)))
}
