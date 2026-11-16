// @@@5856 「群里 agent 超过 5 个 → 全员转 passive」那条系统消息的定位。
//
// 为什么要一个 hook 而不是每条系统消息各查一次:每个群**最多一条**台账(spec:只做一次),
// 所以一条线查一次就够。逐条消息去查等于把 O(1) 做成 O(n) 次往返。
import { useCallback, useEffect, useRef } from 'react'
import { topicService, type AgentFloodAdjustment } from '@/lib/topics'
import { agentFloodNotice } from '@/lib/agentFloodAdjustments'
import { useReplica } from '@/lib/replica'

export function useAgentFloodNotice(
  chatId: string | null,
  /**
   * 这条线当前的消息。只用来取「最后一条系统消息的 id」当重查信号 ——
   * 自动调档的触发器是 AFTER INSERT ON chat_members,也就是你**刚加完第 6 个 agent、正看着这个群**
   * 的那一刻落的消息。原先只在切会话时查台账 ⇒ 首次发生时那颗「一键全撤」根本不存在,
   * 切走再切回来才长出来,而 spec 要的是「**就在那条消息上**一键全撤」。
   */
  messages: readonly { id: string; content_type: string }[] = [],
): {
  /** 承载「一键全撤」的那条系统消息 id;没有、还没读到或没读成都是 null(那条消息上不挂按钮)。 */
  noticeMessageId: string | null
  reload: () => void
} {
  // 按线分键:切会话那一帧拿到的就是这条线的读数,❌ 顶着上一条线的。
  const reading = useReplica(agentFloodNotice, chatId ? [chatId] : null)
  // 取最后一条系统消息的 id:它变了就说明这条线上刚落了一条系统消息,台账值得再查一次。
  // ❌ 不按 messages 整体做依赖 —— 那会让每一条普通消息都触发一次往返。
  let latestSystemMessageId: string | null = null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.content_type === 'system') { latestSystemMessageId = messages[index]!.id; break }
  }
  const seen = latestSystemMessageId
  // Only a system message landing on this chat since asks again (❌ a second ledger read per open).
  const shown = useRef<{ chatId: string | null; seen: string | null } | null>(null)
  useEffect(() => {
    const before = shown.current
    shown.current = { chatId, seen }
    if (chatId && seen && before?.chatId === chatId && before.seen !== seen) void agentFloodNotice.refresh(chatId)
  }, [chatId, seen])

  return {
    noticeMessageId: reading.state === 'value' ? reading.value : null,
    reload: useCallback(() => { if (chatId) void agentFloodNotice.refresh(chatId) }, [chatId]),
  }
}

export type { AgentFloodAdjustment }
export { topicService }
