import { messageForUser } from '@/lib/userFacingError';
import { useReplica } from '../../lib/replica'
import { assistantDm } from '../../lib/assistantDm'
import { useChatStoreSelect } from '../../store/chatContext'

export type AssistantDm = { chatId: string | null; failed: { error: string } | null; retry: () => void }

/**
 * 壳挂着就认出来(AssistantShellHost、手机):聊天格子画它,「今天」页读它的文件夹(today.json),同一条。
 * 会话列表里已经有这一条就用那一行(❌ 再问一次)。
 */
export function useAssistantDm(assistantId: string | null): AssistantDm {
  // 只订阅这条私聊的 id:会话列表每来一条消息都换一份,❌ 订阅整份会让挂着它的壳(桌面外壳也调手机壳的 hook)跟着整棵重渲。
  const existing = useChatStoreSelect((store) => assistantId
    ? store.chats.find((chat) => (chat.kind === 'dm' || chat.kind === 'ai') && chat.peer_user_id === assistantId)?.id ?? null
    : null)
  const reading = useReplica(assistantDm, assistantId && !existing ? [assistantId] : null)
  const chatId = existing ?? (reading.state === 'value' ? reading.value : null)
  return {
    chatId,
    failed: chatId === null && reading.state === 'error' ? { error: messageForUser(reading.error) } : null,
    retry: () => { if (assistantId) void assistantDm.refresh(assistantId) },
  }
}
