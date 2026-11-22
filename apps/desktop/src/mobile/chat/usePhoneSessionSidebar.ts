import { isChatListed } from '@gugu/core/shared/ui/chatModels'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { useSidebarPinnedAgents } from '@/lib/sidebarChatsBridge'
import { oneListAgentRows, oneListShows, useAgentHomes } from '@/lib/sidebarOneList'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { useChatStore } from '@/store/chatContext'
import { useTopicsOfChat } from '@/hooks/useTopics'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { agentFamilies, type ChatAgentScope } from '@renderer/features/sidebar/chat-agents'
import { followInnerSidebar, viewAnchor, type InnerSidebarRoomAnchor } from '@renderer/features/sidebar/inner-sidebar-anchor'
import { columnAgents, standaloneAgentAnchor } from '@renderer/features/sidebar/inner-sidebar-column'

export function usePhoneSessionSidebar({ sessionId, entry }: { sessionId: string; entry: string | null }) {
  const { chats, identitiesById, drafts, subscribeAccountRevision } = useChatStore('chats', 'identitiesById', 'drafts', 'subscribeAccountRevision')
  const summaries = useChatSummaries()
  const devices = useDirectoryDevices()
  const live = useLiveDeviceSessions()
  const directory = directoryRows(devices, live)
  useOwnedAgentEntries()
  const pins = useSidebarPinnedAgents()
  const homes = useAgentHomes(true, chats, pins)
  const shown = chats.filter(chat => homes && oneListShows(chat, isChatListed(chat, { hasDraft: !!drafts[chat.id]?.trim() }), homes, isOwnedAgentPeer))
  const rows = oneListAgentRows(shown, new Map(pins.map(pin => [chats.find(chat => chat.peer_user_id === pin.agentUserId)?.id ?? pin.sessionId, pin])), isOwnedAgentPeer, identitiesById)
  const families = agentFamilies(directory.map(({ deviceId, session }) => ({ id: session.conversationId,
    projectId: `${deviceId}\u0000${session.projectId}`, parentSessionId: session.parentConversationId,
    time: Date.parse(session.lastInteractedAt ?? '') || 0, agentUserId: session.agent?.userId,
    bornInChatId: session.bornInChatId, groupChatId: session.groupChatId ?? null })))
  const scope = (room: InnerSidebarRoomAnchor): ChatAgentScope => ({
    here: id => id === room.chatId || summaries.get(id)?.sourceChatId === room.chatId })
  const agentAnchor = (id: string) => standaloneAgentAnchor(id, families, rows)
  const entryId = entry?.startsWith('chat:') ? entry.slice(5) : null
  const entryAnchor = entryId ? viewAnchor({ kind: 'chat', chatId: entryId, chatKind: summaries.get(entryId)?.kind ?? null })
    : entry?.startsWith('session:') ? agentAnchor(entry.slice(8)) : null
  const anchor = followInnerSidebar(entryAnchor, { kind: 'session', sessionId },
    (room, id) => columnAgents(room, families, summaries, rows, scope).some(agent => agent.id === id), agentAnchor, () => false)
  const listed = anchor ? columnAgents(anchor, families, summaries, rows, scope) : []
  const source = anchor && anchor.kind !== 'agent' ? anchor.chatId : null
  const topics = useTopicsOfChat(source, subscribeAccountRevision)
  return { anchor, listed, directory, devices, identitiesById, families, source, topics, sessionId }
}

export type PhoneSessionSidebarModel = ReturnType<typeof usePhoneSessionSidebar>
