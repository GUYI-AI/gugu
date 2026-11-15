import { useState } from 'react'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { isChatListed } from '@gugu/core/shared/ui/chatModels'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { Hash, Users, ChevronRight } from '@/lib/icons'
import { followLink } from '@/lib/guguLinks'
import { useChatSummaries } from '@/lib/chatSummariesBridge'
import { useSidebarPinnedAgents } from '@/lib/sidebarChatsBridge'
import { oneListAgentRows, oneListShows, useAgentHomes } from '@/lib/sidebarOneList'
import { isOwnedAgentPeer, useOwnedAgentEntries } from '@/lib/ownedAgentConversation'
import { useChatStore } from '@/store/chatContext'
import { useTopicsOfChat } from '@/hooks/useTopics'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store'
import { agentFamilies, type ChatAgentScope } from '@renderer/features/sidebar/chat-agents'
import { followInnerSidebar, viewAnchor, type InnerSidebarRoomAnchor } from '@renderer/features/sidebar/inner-sidebar-anchor'
import { columnAgents, standaloneAgentAnchor } from '@renderer/features/sidebar/inner-sidebar-column'
import { isProjectChat } from '@renderer/features/sidebar/inner-sidebar-scope'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { preserveComposerFocus } from '../composer/composer-focus'
import { openPhoneSidebarSession } from './phone-sidebar-navigation'
import './room-composer-catalog'
import './phone-room-composer.css'

/** The phone adapts its existing directory to the desktop column's models; it has no separate eligibility list. */
export const PhoneSessionSidebarControls = observer(function PhoneSessionSidebarControls({ sessionId, entry }: { sessionId: string; entry: string | null }) {
  const { t } = useTranslation('mobileRoomControls')
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
  const listed = anchor ? columnAgents(anchor, families, summaries, rows, scope) : []
  const source = anchor && anchor.kind !== 'agent' ? anchor.chatId : null
  const topics = useTopicsOfChat(source, subscribeAccountRevision)
  const [view, setView] = useState<'agents' | 'topics' | null>(null)
  if (!anchor) return null
  const nextEntry = anchor.kind === 'agent' ? `session:${families.topLevelOf.get(anchor.agentUserId)?.[0]?.id ?? sessionId}` : `chat:${anchor.chatId}`
  return <div className="gg-phone-room-controls" data-testid="phone-session-sidebar-controls" data-anchor-kind={anchor.kind} data-anchor-chat={anchor.chatId}>
    <PhoneComposerControlRow>
      {source && <PhoneComposerControl label={t('topics')} icon={<Hash />} testId="phone-room-topics" onClick={() => setView('topics')} />}
      <PhoneComposerControl label={t('agents')} icon={<Users />} testId="phone-room-agents" onClick={() => setView('agents')} />
    </PhoneComposerControlRow>
    <PhoneComposerSheet open={view !== null} onClose={() => setView(null)} title={t(view ?? 'agents')} testId="phone-room-controls-sheet" className="gg-phone-room-sheet">
      {view === 'agents' ? listed.map(agent => {
        const row = directory.find(row => row.session.conversationId === agent.id)
        const identity = identitiesById[agent.agentUserId ?? '']
        const name = identity?.display_name ?? row?.session.title ?? ''
        return <Button key={agent.id} variant="ghost" className="gg-phone-room-choice gg-phone-room-agent" data-testid="phone-sidebar-agent" data-session-id={agent.id}
          onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus}
          onClick={() => { if (openPhoneSidebarSession(agent.id, nextEntry)) setView(null) }}>
          <Avatar name={name} seed={agent.agentUserId ?? agent.id} avatarUrl={identity?.avatar} isAgent size={36} />
          <span className="gg-phone-room-choice-name">{name}</span><ChevronRight aria-hidden />
        </Button>
      }) : view === 'topics' ? <>
        <Button variant="ghost" className="gg-phone-room-choice" onClick={() => { setView(null); followLink({ kind: 'chat', chatId: anchor.chatId }) }}>{t('main')}</Button>
        {topics.topics.map(topic => <Button key={topic.chat_id} variant="ghost" className="gg-phone-room-choice"
          onClick={() => { setView(null); followLink({ kind: 'chat', chatId: topic.chat_id }) }}><Hash /><span className="gg-phone-room-choice-name">{topic.name}</span></Button>)}
        {topics.error && <p role="alert">{topics.error}</p>}
      </> : null}
    </PhoneComposerSheet>
  </div>
})
