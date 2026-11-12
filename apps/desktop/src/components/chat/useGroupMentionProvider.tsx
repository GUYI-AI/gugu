import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatComposer, MentionItem } from '@gugu/session-ui/react/components'
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { buildGroupRosterCandidates, MENTION_ALL_USER_ID, type MentionCandidate } from '@/lib/mention'
import type { ChatItem, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { EMPTY_GROUP_COLLAB, useGroupCollabLoader } from '../../hooks/useGroupCollabLoader'
import { useAgentDisplayStatuses } from '../../hooks/useAgentDisplayStatus'
import { useMobileShell } from '../../hooks/useMobileShell'
import { groupClashNames, NO_CLASH_NAMES } from '../../lib/chatClashNames'
import { useAuth } from '../../store/auth'
import { isMentionQueryActive } from '@/lib/mentionMatch'
import { rankMentionCandidates } from '@/lib/mentionRanking'
import { useProjectGroupMembers } from '@/lib/projectGroupChatsBridge'
import { useContactsStore } from '../../store/contactsContext'
import { useChatStore, useChatStoreSelect } from '../../store/chatContext'
import { Avatar } from '../Avatar'
import { createLocalSessionMentionProvider } from '../../session/renderer/lib/chat/local-session-mention-provider'
import { useSessionAgentCreationTools } from '../../session/renderer/lib/chat/use-session-agent-creation-tools'
import { AgentMentionOptionLabel } from './AgentMentionStatusNotice'
import { mentionOptionStatusProps } from './agentMentionStatusModels'
import type { ChatMessageComposerProps } from './chatComposerModels'
import type { MentionTarget } from './useChatDraft'

/**
 * The group's @: who can be named in a chat, the editor's suggestion provider over them, their icons, and the pick a
 * suggestion makes. One implementation for every editor that writes into a chat (the composer, a forward's note).
 * `enabled: false` (a whisper, a forward into several chats) offers no one.
 */
export function useGroupMentionProvider({ chatId, isGroupChat, groupMembers, currentUserId, agentStatuses = {}, messages, participantIds, replyToMessageId, enabled = true }: {
  chatId: string | null | undefined
  isGroupChat: boolean
  groupMembers: NonNullable<ChatMessageComposerProps['groupMembers']>
  currentUserId: string | null
  agentStatuses?: ChatMessageComposerProps['agentStatuses']
  messages?: ChatMessageComposerProps['messages']
  participantIds?: ChatMessageComposerProps['participantIds']
  replyToMessageId?: string
  enabled?: boolean
}) {
  const { t } = useTranslation('messaging')
  const { contacts } = useContactsStore()
  const sourceChatId = useChatStoreSelect((store) => store.chats.find((chat) => chat.id === chatId)?.source_chat_id ?? null)
  const projectMembers = useProjectGroupMembers()
  const projectMemberIds = projectMembers.get(sourceChatId ?? chatId ?? '')
  const members = useMemo<MentionCandidate[]>(() => isGroupChat ? [
    { id: '__all__', name: t('composer.mentionAll'), type: 'all' },
    ...groupMembers.filter((member) => member.id !== currentUserId).map((member) => ({ ...member, alias: contacts.find((contact) => contact.id === member.id)?.alias })),
  ] : [], [isGroupChat, groupMembers, currentUserId, contacts, t])
  const { byEngine, renderMentionIcon: renderSessionMentionIcon } = useSessionAgentCreationTools()
  const renderMentionIcon = useCallback<NonNullable<Parameters<typeof ChatComposer>[0]['renderMentionIcon']>>((attrs) => {
    if (attrs.id === MENTION_ALL_USER_ID) return <Avatar name={attrs.name ?? attrs.label} size={14} variant="group"
      memberAvatars={members.filter((member) => member.type !== 'all').map((member) => ({ id: member.id, name: member.name, avatar: member.avatar ?? null }))} />
    return renderSessionMentionIcon(attrs)
  }, [members, renderSessionMentionIcon])
  const localProvider = useMemo(() => createLocalSessionMentionProvider({ creationToolsByEngine: byEngine }), [byEngine])
  const decorate = useCallback((item: MentionItem): MentionItem => ({ ...item,
    annotation: isGroupChat && !members.some((member) => `aid:${member.id}` === item.label) ? t('composer.notInGroup') : item.annotation,
  }), [isGroupChat, members, t])
  const offered = isGroupChat && enabled
  const mentionProvider = useMemo(() => ({
    allowSpaces: true,
    emptyLabel: offered ? t('composer.mentionNoMatch') : undefined,
    isQueryActive: (query: string) => offered && isMentionQueryActive(query, members),
    async search(query: string) {
      if (!offered || !isMentionQueryActive(query, members)) return []
      return rankMentionCandidates(members, query, { chatId, currentUserId, messages: messages ?? [], participantIds, projectMemberIds,
        replyToMessageId, now: Date.now() }).map((member): MentionItem => ({
        id: member.type === 'all' ? MENTION_ALL_USER_ID : member.id,
        label: member.rawName ? `aid:${member.id}` : member.name, name: member.rawName ?? member.name, kind: 'custom', role: member.type === 'all' ? undefined : member.type,
        annotation: member.rawName ? member.name.slice(member.rawName.length).trim() : undefined,
        optionLabel: <span {...mentionOptionStatusProps(member, agentStatuses ?? {})}><AgentMentionOptionLabel member={member} status={agentStatuses?.[member.id]} /></span>,
      }))
    },
    resolve(target: string, label: string): MentionItem | null {
      const file = parseGroupFileLink(target)
      if (file) return { id: target, label: target, name: label, kind: 'file',
        description: file.version === undefined ? label : `${label} · ${t('filePill.picked', { version: file.version })}` }
      if (!target.startsWith('aid:')) return null
      const member = members.find(candidate => `aid:${candidate.id}` === target)
      return decorate({ id: target, label: target, name: member?.rawName ?? member?.name ?? label, role: member?.type === 'human' ? 'human' : 'agent', kind: 'custom', annotation: member?.rawName ? member.name.slice(member.rawName.length).trim() : undefined })
    },
    async resolveSession(id: string) {
      const item = await localProvider.resolveSession(id)
      return item ? decorate(item) : null
    },
  }), [offered, members, agentStatuses, decorate, localProvider, t, chatId, currentUserId, messages, participantIds, projectMemberIds, replyToMessageId])
  /** The pick a chosen suggestion makes, or null when it is not a member. */
  const pickOf = useCallback((item: MentionItem): MentionTarget | null => {
    const member = members.find((candidate) => candidate.id === item.id || `aid:${candidate.id}` === item.label)
    if (!member) return null
    return { userId: member.type === 'all' ? MENTION_ALL_USER_ID : member.id, displayName: member.name }
  }, [members])
  return { members, mentionProvider, renderMentionIcon, pickOf }
}

/** Who can be @-ed in a chat that is not the one on screen (a forward's target): its roster, loaded the way the open chat's is. */
export function useChatMentionRoster(chat: ChatItem | null) {
  const { getImRepository, identitiesById } = useChatStore('getImRepository', 'identitiesById')
  const { user } = useAuth()
  const mobile = useMobileShell()
  const [snapshot, setSnapshot] = useState<GroupCollabSnapshot>(EMPTY_GROUP_COLLAB)
  const cache = useRef(new Map<string, GroupCollabSnapshot>())
  const room = !!chat && isRoomChat(chat.kind)
  const { loadGroupCollab } = useGroupCollabLoader({ activeChatId: room ? chat.id : null, isRoomChat: room, chatKind: chat?.kind,
    userId: user?.id, getImRepository, setGroupCollabSnapshot: setSnapshot, groupRosterMemoryCacheRef: cache })
  useEffect(() => {
    setSnapshot(EMPTY_GROUP_COLLAB)
    void loadGroupCollab()
  }, [loadGroupCollab])
  const groupMembers = useMemo(() => buildGroupRosterCandidates(snapshot, identitiesById, mobile ? NO_CLASH_NAMES : groupClashNames(snapshot, identitiesById)),
    [snapshot, identitiesById, mobile])
  const agentStatuses = useAgentDisplayStatuses(useMemo(() => snapshot.agents.map((agent) => agent.id), [snapshot.agents]))
  return { room, groupMembers, agentStatuses }
}
