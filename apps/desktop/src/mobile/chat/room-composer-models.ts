import type { ChatItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { oneListNewsDot } from '@/lib/chatLineUnread'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'

/** Each row's mark follows the chat-list rule: calls you (red @N, chatAttention.callsYou), else news (grey dot). */
export function roomTopicChoices(chatId: string, topics: readonly TopicSummary[], chats: readonly ChatItem[]) {
  const byId = new Map(chats.map(chat => [chat.id, chat]))
  const asking = (id: string) => { const chat = byId.get(id); return chat ? chatAttention(chat).askingYou : 0 }
  const mark = (id: string) => {
    const chat = byId.get(id)
    const calls = chat ? chatAttention(chat).callsYou : 0
    return { calls, news: !!chat && oneListNewsDot(chat, calls) }
  }
  const main = mark(chatId)
  const rows = [...topics].sort((a, b) => Number(asking(b.chat_id) > 0) - Number(asking(a.chat_id) > 0))
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
 * The Agents sheet's order: the last one to act first (presence lastActionAt), then the newest account, then id.
 * No status tiers: status is the avatar badge and the row text, never the position.
 */
export function roomAgentsByRecentActivity<T extends { id: string }>(agents: readonly T[], lastActionAt: (id: string) => string | null | undefined, createdAt: (id: string) => string | null | undefined): T[] {
  const time = (at: string | null | undefined) => at ? Date.parse(at) || 0 : 0
  return [...agents].sort((a, b) => time(lastActionAt(b.id)) - time(lastActionAt(a.id)) || time(createdAt(b.id)) - time(createdAt(a.id))
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
