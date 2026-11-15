import { openPhoneSidebarSession } from './phone-sidebar-navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { Avatar } from '@/components/Avatar'
import type { MemberProfileCardModel, MemberProfileChatTarget } from '@/components/MemberProfileCard'
import type { MemberProfileOpener } from '@/components/memberProfileModels'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { Popover } from '@/components/ui/Popover'
import { ChevronRight, Hash, Users } from '@/lib/icons'
import { agentDisplayStatusText } from '@/lib/agentStatusText'
import { useChatStore } from '@/store/chatContext'
import { useAgentSessionRow } from '../agent-watch/useAgentSessionRow'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { preserveComposerFocus } from '../composer/composer-focus'
import { PhoneCreateAgentAction } from '../composer/PhoneCreateAgentAction'
import { requestPhoneAgentCreation } from '../agent-watch/phone-agent-creation'
import { PhoneTopicChoice } from './PhoneTopicChoice'
import { roomAgentEntry, roomTopicChoices } from './room-composer-models'
import '../agent-watch/create-controls-catalog'
import './room-composer-catalog'
import './phone-room-composer.css'

export type PhoneRoomComposerControlsProps = {
  chatId: string
  topics: readonly TopicSummary[]
  current: { chatId: string; name: string } | null
  onPick: (topic: TopicSummary | null) => void
  members: readonly MemberProfileCardModel[]
  roster: { ready: boolean; failed: boolean; retry: () => void }
  userId: string | null
  profileOpener: MemberProfileOpener
  onOpenAgent?: (target: MemberProfileChatTarget) => void
}

export function PhoneRoomComposerControls(props: PhoneRoomComposerControlsProps) {
  return <RoomComposerControls key={`${props.chatId}:${props.current?.chatId ?? ''}`} {...props} />
}

function RoomComposerControls({ chatId, topics, current, onPick, members, roster, userId, profileOpener, onOpenAgent }: PhoneRoomComposerControlsProps) {
  const { t } = useTranslation('mobileRoomControls')
  const { chats } = useChatStore('chats')
  const [view, setView] = useState<'topics' | 'agents' | null>(null)
  const choices = roomTopicChoices(chatId, topics, chats)
  const agents = members.filter(member => member.type === 'agent' && member.membership !== 'former')
  const choose = (topic: TopicSummary | null) => {
    setView(null)
    if ((topic?.chat_id ?? null) !== (current?.chatId ?? null)) onPick(topic)
  }
  return <div className="gg-phone-room-controls" data-testid="phone-room-composer-controls">
    <PhoneComposerControlRow>
      <PhoneComposerControl label={t('topics')} icon={<Hash />} active={!!current}
        badge={choices.unreadCount > 0 ? <Chip shape="count" tone="danger" aria-label={t('unread', { count: choices.unreadCount })}>{choices.unreadCount.toLocaleString()}</Chip> : undefined}
        testId="phone-room-topics" onClick={() => setView('topics')} />
      <PhoneComposerControl label={t('agents')} icon={<Users />} testId="phone-room-agents" onClick={() => setView('agents')} />
    </PhoneComposerControlRow>
    <PhoneComposerSheet open={view !== null} onClose={() => setView(null)} title={t(view ?? 'topics')} testId="phone-room-controls-sheet" className="gg-phone-room-sheet">
      {view === 'topics' ? <div role="radiogroup" aria-label={t('topics')}>
        <PhoneTopicChoice name={t('main')} unread={choices.mainUnread} selected={!current} main onClick={() => choose(null)} />
        {choices.topics.map(topic => <PhoneTopicChoice key={topic.chat_id} name={topic.name} unread={topic.unread}
          selected={topic.chat_id === current?.chatId} id={topic.chat_id} onClick={() => choose(topic)} />)}
      </div> : view === 'agents' ? <>
        <PhoneCreateAgentAction onCreate={() => { setView(null); requestPhoneAgentCreation(chatId) }} />
        {agents.map(profile => <RoomAgentChoice key={profile.id} profile={profile} userId={userId} opener={profileOpener}
          onOpen={onOpenAgent ? target => { setView(null); if (!target.session || !openPhoneSidebarSession(target.session.sessionId, `chat:${chatId}`)) onOpenAgent(target) } : undefined} />)}
        {roster.failed ? <div role="alert" className="gg-phone-room-empty">{t('failed')} <Button variant="ghost" size="sm" onClick={roster.retry}>{t('retry')}</Button></div>
          : !roster.ready ? <p role="status" className="gg-phone-room-empty">{t('loading')}</p>
            : agents.length === 0 && <p className="gg-phone-room-empty">{t('noAgents')}</p>}
      </> : null}
    </PhoneComposerSheet>
  </div>
}

function RoomAgentChoice({ profile, userId, opener, onOpen }: {
  profile: MemberProfileCardModel; userId: string | null; opener: MemberProfileOpener
  onOpen?: (target: MemberProfileChatTarget) => void
}) {
  const { t } = useTranslation('mobileRoomControls')
  const session = useAgentSessionRow(profile.ownerUserId === userId ? profile.id : null)
  const entry = roomAgentEntry(profile, userId, !!session && !!onOpen)
  const status = profile.agentStatus
  const task = status === 'working' || status === 'parked' || status === 'needs_user' ? profile.agentMeta?.currentTaskTitle : null
  const body = <>
    <Avatar name={profile.displayName} seed={profile.id} avatarUrl={profile.avatar} isAgent agentStatus={status} size={36} />
    <span className="gg-phone-room-agent-text"><span className="gg-phone-room-choice-name">{profile.displayName}</span>
      <span className="gg-phone-room-agent-detail">{status && <span>{agentDisplayStatusText(status)}</span>}{task && <span>{task}</span>}</span>
    </span><ChevronRight aria-hidden />
  </>
  const props = { variant: 'ghost' as const, className: 'gg-phone-room-choice gg-phone-room-agent',
    'data-testid': 'phone-room-agent', 'data-agent-id': profile.id, 'data-entry': entry,
    title: t(entry === 'session' ? 'openSession' : 'openProfile'), onPointerDown: preserveComposerFocus, onMouseDown: preserveComposerFocus }
  if (entry === 'session' && session) return <Button {...props} onClick={() => onOpen?.({ id: profile.id,
    displayName: profile.displayName, avatar: profile.avatar, email: profile.email, bio: profile.bio ?? null, type: 'agent',
    session: { projectId: session.session.projectId, sessionId: session.session.conversationId } })}>{body}</Button>
  return <Popover.Trigger handle={opener.handle} payload={{ member: profile, openedFrom: opener.openedFrom }}
    render={<Button {...props}>{body}</Button>} />
}
