import { isChatListed } from '@gugu/core/shared/ui/chatModels'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { useSidebarPinnedAgents } from '@/lib/sidebarChatsBridge'
import { oneListAgentRows, oneListShows, useAgentHomes } from '@/lib/sidebarOneList'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { useChatStore } from '@/store/chatContext'
import { useTopicsOfChat } from '@/hooks/useTopics'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store'
import { orderAgentRows } from '@renderer/features/sidebar/agent-order'
import { agentFamilies, type ChatAgentScope } from '@renderer/features/sidebar/chat-agents'
import { followInnerSidebar, viewAnchor, type InnerSidebarRoomAnchor } from '@renderer/features/sidebar/inner-sidebar-anchor'
import { columnAgents, standaloneAgentAnchor } from '@renderer/features/sidebar/inner-sidebar-column'
import { isProjectChat } from '@renderer/features/sidebar/inner-sidebar-scope'

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
  const projectKey = (device: string, project: string) => `${device}\u0000${project}`
  const families = agentFamilies(directory.map(({ deviceId, session }) => ({ id: session.conversationId,
    projectId: projectKey(deviceId, session.projectId), parentSessionId: session.parentConversationId,
    isPinned: false, time: Date.parse(session.lastInteractedAt ?? '') || 0, agentUserId: session.agent?.userId,
    bornInChatId: session.bornInChatId })))
  const projects = accountProjectsStore.projects.filter(project => !project.archived)
  const projectIds = new Set(projects.flatMap(project => project.bindings.map(binding => projectKey(binding.deviceId, binding.localProjectId))))
  const scope = (room: InnerSidebarRoomAnchor): ChatAgentScope => ({ kind: room.kind,
    projectIds: room.kind === 'project' ? projects.filter(project => project.chatId === room.chatId).flatMap(project => project.bindings.map(binding => projectKey(binding.deviceId, binding.localProjectId))) : [],
    bornHere: id => id === room.chatId || summaries.get(id)?.sourceChatId === room.chatId,
    inProject: id => projectIds.has(id) })
  const agentAnchor = (id: string) => standaloneAgentAnchor(id, families, rows)
  const entryId = entry?.startsWith('chat:') ? entry.slice(5) : null
  const entryAnchor = entryId ? viewAnchor({ kind: 'chat', chatId: entryId, chatKind: summaries.get(entryId)?.kind ?? null, projectGroup: isProjectChat(entryId) })
    : entry?.startsWith('session:') ? agentAnchor(entry.slice(8)) : null
  const anchor = followInnerSidebar(entryAnchor, { kind: 'session', sessionId },
    (room, id) => columnAgents(room, families, summaries, rows, scope).some(agent => agent.id === id), agentAnchor, () => false)
  // 次序同桌面「智能体」(agent-order);手机的目录没有状态,同一档里按最近交互。
  const listed = anchor ? orderAgentRows(columnAgents(anchor, families, summaries, rows, scope)) : []
  const source = anchor && anchor.kind !== 'agent' ? anchor.chatId : null
  const topics = useTopicsOfChat(source, subscribeAccountRevision)
  return { anchor, listed, directory, devices, identitiesById, families, source, topics, sessionId }
}

export type PhoneSessionSidebarModel = ReturnType<typeof usePhoneSessionSidebar>
