import { useShownAgentName } from '@/hooks/useShownAgentName'
import { formatCalendarDay } from '@/i18n/format'
import { useChatStore } from '@/store/chatContext'
import { sessionPresentation } from '@/mobile/agent-watch/watch-status'
import { agentStatusText } from '@/lib/agentStatusText'
import { displayStatusOf } from '@gugu/core/shared/ui/agentConversationStatusModels'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { responderName } from '@/mobile/agent-watch/responder'
import { Avatar } from '../Avatar'
import { AgentContactStatusMark } from '../AgentContactStatusMark'
import { ListRow } from '../ui/ListRow'
import { Chip } from '../ui/Chip'
import { PhoneMessageAvatar } from '@/mobile/chat/PhoneMessageAvatar'
import type { NeedsYouTask } from './useNeedsYouTasks'

/** Attention tasks retain their canonical status without restoring standalone tasks to Chats. */
export const NeedsYouTaskRow = observer(function NeedsYouTaskRow({ task, onClick, onKeyDown, mobile = true, emphasis }: {
  task: NeedsYouTask
  mobile?: boolean
  /** Unread (still counted): bold title, status mark on the avatar and the chat list's unread count badge. A read row is muted,
   * regular weight, with no mark: its state stays in words on the second line. */
  emphasis: boolean
  onClick: React.MouseEventHandler<HTMLElement>
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
}) {
  const { t } = useTranslation('main')
  const { identitiesById } = useChatStore('identitiesById')
  const { session, handled } = task
  // A handled approval is drawn as read history: no status mark, its outcome in place of the state.
  const presentation = handled ? null : sessionPresentation(session, true)
  const by = handled && responderName(handled.resolvedBy, t)
  const agentId = session.agent?.userId
  const agent = agentId ? identitiesById[agentId] : undefined
  const [name, title] = useShownAgentName([
    { name: agent?.display_name || session.title, createdAt: agent?.created_at ?? undefined },
    { name: session.title, createdAt: agent?.created_at ?? undefined },
  ])
  const time = handled?.resolvedAt ?? Date.parse(session.lastInteractedAt ?? '')
  // The outcome in this surface's words, from the option's kind: the host's option names and title are only its fallback text.
  const outcome = handled?.option?.kind?.startsWith('allow') ? 'Allowed' : handled?.option?.kind?.startsWith('reject') ? 'Declined' : handled?.kind === 'question' ? 'Answered' : ''
  const state = handled
    ? [by ? t(`agentWatch.settlement.handled${outcome}By`, { by }) : t(`agentWatch.settlement.handled${outcome}`)]
    : presentation ? [agentStatusText(presentation.label)] : []
  return <ListRow
    data-session-line={session.conversationId}
    mobile={mobile}
    tabIndex={0}
    role="option"
    aria-selected={false}
    emphasis={emphasis}
    onClick={onClick}
    onKeyDown={onKeyDown}
    leading={<PhoneMessageAvatar badge={emphasis && presentation && <span className="inline-flex" role="img" aria-label={agentStatusText(presentation.label)}><AgentContactStatusMark tone={displayStatusOf(presentation.tone)} /></span>}>
      <Avatar name={name!} avatarUrl={agent?.avatar ?? null} seed={agentId} size={mobile ? 48 : 'sm'} isAgent harnessBadge={false} />
    </PhoneMessageAvatar>}
    title={emphasis ? name : <span className="font-normal text-[var(--muted-fg)]">{name}</span>}
    meta={Number.isFinite(time) ? formatCalendarDay(new Date(time).toISOString()) : undefined}
    subtitle={state.length > 0 ? [...state, ...(title === name ? [] : [title])].join(' · ') : undefined}
    trailing={emphasis ? <Chip tone="accent" shape="count">1</Chip> : undefined}
  />
})
