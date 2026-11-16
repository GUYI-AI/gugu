import { PhoneNavigationPicker } from './PhoneNavigationPicker'
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
import { Check, ChevronRight, Hash, MessageCircle, Users } from '@/lib/icons'
import { agentDisplayStatusText } from '@/lib/agentStatusText'
import { useChatStore } from '@/store/chatContext'
import { useAgentSessionRow } from '../agent-watch/useAgentSessionRow'
import { PhoneComposerControl, PhoneComposerControlRow, PhoneComposerSheet } from '../composer/PhoneComposerControls'
import { preserveComposerFocus } from '../composer/composer-focus'
import { roomAgentEntry, roomTopicChoices } from './room-composer-models'
import '../agent-watch/create-controls-catalog'
import './room-composer-catalog'
import './phone-room-composer.css'
import { phoneMenuBar } from '../composer/phone-menu-bar'

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
  const menu = phoneMenuBar('room', { topics: true, agents: true })
  const choose = (topic: TopicSummary | null) => {
    setView(null)
    if ((topic?.chat_id ?? null) !== (current?.chatId ?? null)) onPick(topic)
  }
  return <div className="gg-phone-room-controls" data-testid="phone-room-composer-controls">
    <PhoneComposerControlRow>
      {menu.includes('topics') && <PhoneComposerControl label={t('topics')} menuExpanded={view === 'topics'} active={!!current} dot={choices.hasUnread}
        testId="phone-room-topics" onClick={() => setView('topics')} />}
      {menu.includes('agents') && <PhoneComposerControl label={t('agents')} icon={<Users />} menuExpanded={view === 'agents'} testId="phone-room-agents" onClick={() => setView('agents')} />}
    </PhoneComposerControlRow>
    <PhoneComposerSheet open={view !== null} onClose={() => setView(null)} title={t(view ?? 'topics')} testId="phone-room-controls-sheet" className="gg-phone-room-sheet">
      {view === 'topics' ? <PhoneNavigationPicker key="topics" kind="topics" items={[null, ...choices.topics]} nameOf={topic => topic?.name ?? t('main')}>
        {shown => <div role="radiogroup" aria-label={t('topics')}>
          {shown.map(topic => topic ? <TopicChoice key={topic.chat_id} name={topic.name} unread={topic.unread}
            selected={topic.chat_id === current?.chatId} id={topic.chat_id} onClick={() => choose(topic)} />
            : <TopicChoice key="main" name={t('main')} unread={choices.mainUnread} selected={!current} main onClick={() => choose(null)} />)}
        </div>}
      </PhoneNavigationPicker> : view === 'agents' ? <PhoneNavigationPicker key="agents" kind="agents" items={agents} nameOf={profile => profile.displayName} ready={roster.ready}>
        {shown => <>
        {shown.map(profile => <RoomAgentChoice key={profile.id} profile={profile} userId={userId} opener={profileOpener}
          onOpen={onOpenAgent ? target => { setView(null); if (!target.session || !openPhoneSidebarSession(target.session.sessionId, `chat:${chatId}`)) onOpenAgent(target) } : undefined} />)}
        {roster.failed ? <div role="alert" className="gg-phone-room-empty">{t('failed')} <Button variant="ghost" size="sm" onClick={roster.retry}>{t('retry')}</Button></div>
          : !roster.ready ? <p role="status" className="gg-phone-room-empty">{t('loading')}</p>
            : agents.length === 0 && <p className="gg-phone-room-empty">{t('noAgents')}</p>}
      </>}
      </PhoneNavigationPicker> : null}
    </PhoneComposerSheet>
  </div>
}

function TopicChoice({ name, unread, selected, onClick, main = false, id }: {
  name: string; unread: number; selected: boolean; onClick: () => void; main?: boolean; id?: string
}) {
  const { t } = useTranslation('mobileRoomControls')
  return <Button variant="ghost" className="gg-phone-room-choice" role="radio" aria-checked={selected}
    data-testid={main ? 'phone-room-main' : 'phone-room-topic'} data-topic-id={id}
    onPointerDown={preserveComposerFocus} onMouseDown={preserveComposerFocus} onClick={onClick}>
    {main ? <MessageCircle aria-hidden /> : <Hash aria-hidden />}
    <span className="gg-phone-room-choice-name gg-phone-room-topic-name">{name}</span>
    {unread > 0 && <Chip shape="count" aria-label={t('unread', { count: unread })}>{unread.toLocaleString()}</Chip>}
    {selected && <Check className="gg-phone-room-check" aria-hidden />}
  </Button>
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
