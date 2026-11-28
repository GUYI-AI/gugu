import type { ChatItem } from '@gugu/core/shared/types/chat'
import { compareChatsByActivityDesc, comparePinnedFirst } from '@gugu/core/shared/ui/chatModels'

/** 这个对话的话题,置顶的在前、再按最近活动(同会话列表);归档的不算。群页头菜单只按活动时间排序。 */
export function topicsOfChat(chats: readonly ChatItem[], chatId: string, { pinnedFirst = true } = {}): ChatItem[] {
  return chats
    .filter((chat) => chat.kind === 'topic' && chat.source_chat_id === chatId && chat.status !== 'archived')
    .sort((a, b) => (pinnedFirst ? comparePinnedFirst(a, b) : 0) || compareChatsByActivityDesc(a, b))
}
