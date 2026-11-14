import { Avatar } from './Avatar'
import { useShownAgentName } from '@/hooks/useShownAgentName'
import { useAvatarIdentity } from '@/lib/avatarIdentity'
import type { AutomationTestId } from '../lib/automationDom'
import type { MemberProfileCardModel } from './MemberProfileCard'
import type { ActiveMemberProfile, MemberProfileHandle } from './memberProfileModels'
import { Popover } from './ui/Popover'
import { useTranslation } from 'react-i18next'

/** An avatar that opens its member's profile card: the card's Trigger (a second press closes it; its open state is lit). */
export function MemberProfileAvatarButton({
  member,
  testId,
  avatarSize = 'sm',
  buttonSize = 34,
  isAgent = member.type === 'agent',
  messageSenderId,
  profile,
}: {
  member: MemberProfileCardModel
  testId: AutomationTestId
  avatarSize?: 'sm' | 'md'
  buttonSize?: number
  isAgent?: boolean
  messageSenderId?: string
  profile: { handle: MemberProfileHandle; payload: ActiveMemberProfile }
}) {
  const { t } = useTranslation('contacts')
  const identity = useAvatarIdentity(isAgent ? member.id : '')
  const name = useShownAgentName({ name: member.displayName, createdAt: isAgent ? identity?.created_at ?? undefined : undefined })
  return (
    <Popover.Trigger
      handle={profile.handle}
      payload={profile.payload}
      className="gg-pressable border border-transparent bg-transparent data-[popup-open]:border-[var(--accent)] data-[popup-open]:bg-[var(--accent-tint-row)]"
      data-testid={testId}
      data-group-member-id={member.id}
      data-group-member-type={member.type}
      data-group-member-role={member.role}
      data-message-sender-id={messageSenderId}
      data-profile-member-id={member.id}
      data-profile-member-type={member.type}
      data-profile-member-role={member.role}
      aria-label={t('profile.viewProfile', { name })}
      // 只开这张卡,❌ 再冒泡成点了这一行 / 这条消息。
      onClick={(event) => event.stopPropagation()}
      style={{
        width: buttonSize,
        height: buttonSize,
        borderRadius: avatarSize === 'md' ? 7 : 8,
        color: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <Avatar
        name={name}
        avatarUrl={member.avatar}
        seed={member.id}
        size={avatarSize}
        isAgent={isAgent}
        agentStatus={member.agentStatus}
      />
    </Popover.Trigger>
  )
}
