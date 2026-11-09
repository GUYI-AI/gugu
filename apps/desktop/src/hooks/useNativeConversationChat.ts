import { useChatSummariesSelect } from '@/lib/chatSummariesBridge'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { useConversationSessionSummary } from './useConversationSessionSummary'

/** Sidebar selection follows the visible task workspace, including its browser and App tabs. */
export function useNativeConversationChat(sessionId: string | undefined): string | null {
  const session = useConversationSessionSummary(sessionId)
  useOwnedAgentEntries()
  const agentId = session?.agent?.userId
  const chatId = useChatSummariesSelect((chats) => {
    if (!agentId) return null
    for (const [id, chat] of chats) if ((chat.kind === 'dm' || chat.kind === 'ai') && chat.peerUserId === agentId) return id
    return null
  })
  return isOwnedAgentPeer(agentId) ? chatId : null
}
