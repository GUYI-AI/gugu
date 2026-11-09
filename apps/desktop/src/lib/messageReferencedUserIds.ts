import type { MessageItem } from '@gugu/core/shared/types/chat'

/**
 * 一批消息引用到的人:发送者、被回复者、@ 的收件人(`*` = 所有人,不是人)。
 * 退群 / 被移出的人没有成员行,只有这些消息还引用着他 —— 补身份(消息窗口)和建「已不在群」的资料
 * (气泡的发送者名、收件人行)都按这一份算,收件人不会漏成原始 id (#2383)。
 */
export function messageReferencedUserIds(messages: readonly Pick<MessageItem, 'sender_user_id' | 'reply_to_sender_user_id' | 'to_user_ids'>[]): string[] {
  const ids: string[] = []
  for (const message of messages) {
    for (const id of [message.sender_user_id, message.reply_to_sender_user_id, ...(message.to_user_ids ?? [])]) if (id && id !== '*') ids.push(id)
  }
  return ids
}
