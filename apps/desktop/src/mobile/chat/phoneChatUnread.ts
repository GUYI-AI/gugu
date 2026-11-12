import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { chatLineCounts } from '@/lib/chatLineUnread'

/**
 * 手机一段对话只有一行：话题未读并入来源行，不能受当前搜索或沉降影响。
 * 并进来的话题只算叫到你的(owner 10-28,与桌面项目行、通知同一条):agent 之间的往来不把这一行点亮。
 * 手机上不知道哪些群是项目群(那份名单在桌面任务页),所以对每个群的话题都这样算 —— 与通知的口径一致。
 * 并法与桌面一个列表同一份(chatLineCounts);手机这一行的主聊天照旧全算(forYou)。
 */
export function phoneChatUnread(chats: readonly ChatItem[]): ReadonlyMap<string, number> {
  return chatLineCounts(chats, (chat) => chatAttention(chat).forYou)
}
