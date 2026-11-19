import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatComposer, MentionItem } from '@gugu/session-ui/react/components'
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink'
import { addressedUserIds, buildGroupRosterCandidates, MENTION_ALL_USER_ID, type MentionCandidate } from '@/lib/mention'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'
import { useRoomCollab } from '../../hooks/useRoomCollab'
import { useAgentDisplayStatuses } from '../../hooks/useAgentDisplayStatus'
import { isMentionQueryActive } from '@/lib/mentionMatch'
import { rankMentionCandidates } from '@/lib/mentionRanking'
import { useGroupAgents } from '@/lib/agentSessionsBridge'
import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
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
  const groupAvatarUrl = useChatStoreSelect((store) => store.chats.find((chat) => chat.id === chatId)?.avatar ?? null)
  const sourceChatId = useChatStoreSelect((store) => store.chats.find((chat) => chat.id === chatId)?.source_chat_id ?? null)
  const groupAgents = useGroupAgents()
  const groupAgentIds = groupAgents.get(sourceChatId ?? chatId ?? '')
  const members = useMemo<MentionCandidate[]>(() => isGroupChat ? [
    { id: '__all__', name: t('composer.mentionAll'), type: 'all' },
    ...groupMembers.filter((member) => member.id !== currentUserId).map((member) => ({ ...member, alias: contacts.find((contact) => contact.id === member.id)?.alias })),
  ] : [], [isGroupChat, groupMembers, currentUserId, contacts, t])
  const { byEngine, renderMentionIcon: renderSessionMentionIcon } = useSessionAgentCreationTools()
  const renderMentionIcon = useCallback<NonNullable<Parameters<typeof ChatComposer>[0]['renderMentionIcon']>>((attrs) => {
    if (attrs.id === MENTION_ALL_USER_ID) return <Avatar name={attrs.name ?? attrs.label} size={14} variant="group" seed={chatId ?? undefined} avatarUrl={groupAvatarUrl} />
    return renderSessionMentionIcon(attrs)
  }, [chatId, groupAvatarUrl, renderSessionMentionIcon])
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
      return rankMentionCandidates(members, query, { chatId, currentUserId, messages: messages ?? [], participantIds, groupAgentIds,
        replyToMessageId, now: Date.now() }).map((member): MentionItem => ({
        id: member.type === 'all' ? MENTION_ALL_USER_ID : member.id,
        label: member.name, name: member.name, kind: 'custom', role: member.type === 'all' ? undefined : member.type,
        optionLabel: <span {...mentionOptionStatusProps(member, agentStatuses ?? {})}><AgentMentionOptionLabel member={member} status={agentStatuses?.[member.id]} /></span>,
      }))
    },
    resolve(target: string, label: string): MentionItem | null {
      const file = parseGroupFileLink(target)
      if (file) return { id: target, label: target, name: label, kind: 'file',
        description: file.version === undefined ? label : `${label} (${t('filePill.picked', { version: file.version })})` }
      if (!target.startsWith('aid:')) return null
      return decorate({ id: target, label: target, name: label, role: 'agent', kind: 'custom' })
    },
    async resolveSession(id: string) {
      const item = await localProvider.resolveSession(id)
      return item ? decorate(item) : null
    },
  }), [offered, members, agentStatuses, decorate, localProvider, t, chatId, currentUserId, messages, participantIds, groupAgentIds, replyToMessageId])
  /** The pick a chosen suggestion makes, or null when it is not a member. */
  const pickOf = useCallback((item: MentionItem): MentionTarget | null => {
    const member = members.find((candidate) => candidate.id === item.id || `aid:${candidate.id}` === item.label)
    if (!member) return null
    return { userId: member.type === 'all' ? MENTION_ALL_USER_ID : member.id, displayName: member.name }
  }, [members])
  return { members, mentionProvider, renderMentionIcon, pickOf }
}

/**
 * A note into a chat that is not the one on screen (a forward's, a selection's Send): the group composer's @ over that
 * chat's members (the same roster replica the open chat reads), and whom its words address. Not a room: no one.
 */
export function useChatNote(chat: ChatItem | null) {
  const { identitiesById } = useChatStore('identitiesById')
  const { user } = useAuth()
  const [picks, setPicks] = useState<MentionTarget[]>([])
  const room = !!chat && isRoomChat(chat.kind)
  const { snapshot } = useRoomCollab(room ? chat.id : null, chat?.kind === 'topic' ? 'topic' : 'group')
  const groupMembers = useMemo(() => snapshot ? buildGroupRosterCandidates(snapshot, identitiesById) : [], [snapshot, identitiesById])
  const agentStatuses = useAgentDisplayStatuses(useMemo(() => snapshot?.agents.map((agent) => agent.id) ?? [], [snapshot?.agents]))
  const { members, mentionProvider, renderMentionIcon, pickOf } = useGroupMentionProvider({ chatId: room ? chat.id : null, isGroupChat: room, groupMembers, currentUserId: user?.id ?? null, agentStatuses })
  const onMentionInsert = useCallback((item: MentionItem) => {
    const pick = pickOf(item)
    if (pick) setPicks((current) => current.some((existing) => existing.userId === pick.userId) ? current : [...current, pick])
  }, [pickOf])
  const addressed = useCallback((text: string) => room ? addressedUserIds(text, picks, members) : [], [room, picks, members])
  return { mentionProvider, renderMentionIcon, onMentionInsert, addressed }
}
