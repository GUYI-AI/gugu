import type { ChatItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'

export function roomTopicChoices(chatId: string, topics: readonly TopicSummary[], chats: readonly ChatItem[]) {
  const byId = new Map(chats.map(chat => [chat.id, chat]))
  const unread = (id: string) => Math.max(0, byId.get(id)?.unread_count ?? 0)
  const calls = (id: string) => { const chat = byId.get(id); return chat ? chatAttention(chat).askingYou : 0 }
  return {
    mainUnread: unread(chatId),
    topics: [...topics].sort((a, b) => Number(calls(b.chat_id) > 0) - Number(calls(a.chat_id) > 0))
      .map(topic => ({ ...topic, unread: unread(topic.chat_id) })),
    hasUnread: unread(chatId) > 0 || topics.some(topic => unread(topic.chat_id) > 0),
  }
}

/** This entry never creates an Agent DM when its task session cannot be opened. */
export function roomAgentEntry(profile: Pick<MemberProfileCardModel, 'type' | 'ownerUserId'>, userId: string | null, hasSession: boolean) {
  return profile.type === 'agent' && !!userId && profile.ownerUserId === userId && hasSession ? 'session' : 'profile'
}
