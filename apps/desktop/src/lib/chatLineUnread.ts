import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'

/**
 * 一段对话一行:话题的数并进它的来源行(手机消息列表、桌面一个列表同一个并法,❌ 各写一份)。
 * 每条会话记几由调用方从 chatAttention 里挑;没有来源的话题不记(列表里没有那一行)。并的时候不看搜索与沉降。
 */
export function chatLineCounts(chats: readonly ChatItem[], count: (chat: ChatItem) => number): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const chat of chats) {
    const source = chat.kind === 'topic' ? chat.source_chat_id : chat.id
    if (source) counts.set(source, (counts.get(source) ?? 0) + count(chat))
  }
  return counts
}

/**
 * #2548 桌面一个列表一行的红数字 = 叫到你的(chatAttention.callsYou):点名你、@所有人、回复你说的,
 * 群这一行是主聊天里的加上它的话题里的;私聊每一条都算。
 */
export function oneListCalls(chats: readonly ChatItem[]): ReadonlyMap<string, number> {
  return chatLineCounts(chats, (chat) => chatAttention(chat).callsYou)
}

/**
 * 红数字之外的新消息只挂一个小灰点:这一行自己(主聊天,含回复串)有未读、却没有叫到你。
 * 话题里没叫到你的不点亮来源行(owner 10-28,同手机行与项目行);它们在内层栏话题那一行上挂灰点。
 */
export function oneListNewsDot(chat: Pick<ChatItem, 'unread_count'>, calls: number): boolean {
  return calls === 0 && chat.unread_count > 0
}
