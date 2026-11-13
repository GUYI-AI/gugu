import { useGroupDisplayName } from '../../hooks/useGroupDisplayName'
import { useTranslation } from 'react-i18next'
import type { GroupJoinMode } from '@gugu/core/shared/types/chat'
import { Avatar } from '../Avatar'
import { Button } from '../ui/Button'

export interface GroupInviteCardGroup {
  id?: string
  public_id: number
  name: string
  member_count: number
  is_member: boolean
  join_mode: GroupJoinMode
  join_request_status: 'pending' | 'accepted' | 'rejected' | null
  avatar_url?: string | null
  description?: string | null
  creator_name?: string | null
}
export type GroupInviteCardState =
  | 'joinable'
  | 'joined'
  | 'pending'
  | 'invite_only'
  | 'invite_link_closed'
  | 'failed'
  | 'link_required'
export interface GroupInviteCardProps {
  group: GroupInviteCardGroup
  density?: 'inline' | 'list'
  inviteLinkEnabled?: boolean
  joinTokenAvailable?: boolean
  joining?: boolean
  joinError?: string | null
  onJoin?: () => void
  inactiveAction?: 'text' | 'button'
  className?: string
  testId?: string
}
function cardState(group: GroupInviteCardGroup, inviteLinkEnabled: boolean, joinTokenAvailable: boolean, joinError: string | null): GroupInviteCardState {
  if (group.is_member) return 'joined'
  if (group.join_request_status === 'pending') return 'pending'
  if (!inviteLinkEnabled) return 'invite_link_closed'
  if (group.join_mode === 'invite_only') return 'invite_only'
  if (!joinTokenAvailable) return 'link_required'
  if (joinError) return 'failed'
  return 'joinable'
}
export function GroupInviteCard({
  group,
  density = 'inline',
  inviteLinkEnabled = true,
  joinTokenAvailable = true,
  joining = false,
  joinError = null,
  onJoin,
  inactiveAction = 'text',
  className,
  testId = 'group-invite-card',
}: GroupInviteCardProps) {
  const { t } = useTranslation('contacts')
  const name = useGroupDisplayName(group)
  const state = cardState(group, inviteLinkEnabled, joinTokenAvailable, joinError)
  const requestApproval = group.join_mode === 'approval'
  const actionable = (state === 'joinable' || state === 'failed') && onJoin != null
  const stateLabel: Record<GroupInviteCardState, string> = {
    joinable: requestApproval ? t('groupInvite.requestJoin') : t('groupInvite.join'),
    joined: t('groupInvite.joined'),
    pending: t('groupInvite.pendingApproval'),
    invite_only: t('groupInvite.inviteOnly'),
    invite_link_closed: t('groupInvite.inviteLinkClosed'),
    failed: t('groupInvite.joinFailed'),
    link_required: t('groupInvite.scanToJoin'),
  }
  const actionLabel = requestApproval ? t('groupInvite.requestJoin') : t('groupInvite.join')
  const busyLabel = requestApproval ? t('groupInvite.requesting') : t('groupInvite.joining')
  const inline = density === 'inline'
  return (
    <div
      className={className}
      data-testid={testId}
      data-state={state}
      data-density={density}
      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', minWidth: 0, padding: inline ? 12 : '12px 0', border: inline ? '1px solid var(--border-subtle)' : 'none', borderBottom: inline ? 'none' : '1px solid var(--border-subtle)', borderRadius: inline ? 'var(--radius-surface)' : 0, background: inline ? 'var(--bg-elevated)' : 'transparent' }}
    >
      <Avatar avatarUrl={group.avatar_url ?? null} seed={group.id ?? String(group.public_id)} name={name} variant="group" size={inline ? 40 : 36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: 'var(--text-primary)', fontSize: 'var(--font-body)', fontWeight: 600, lineHeight: 'var(--lh-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', marginTop: 2 }}>
          {t('groupInvite.groupSummary', { number: group.public_id, count: group.member_count })}
        </div>
        {group.creator_name ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t('groupInvite.creator', { name: group.creator_name })}</div>
        ) : null}
        {group.description ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.description}</div>
        ) : null}
        {state === 'invite_link_closed' ? (
          <div className="gg-group-hint" style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', marginTop: 3 }}>{t('groupInvite.inviteLinkClosedHint')}</div>
        ) : null}
        {state === 'failed' && joinError ? (
          <div className="gg-group-join-error" role="alert" data-testid="group-join-error" style={{ color: 'var(--danger-fg)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', marginTop: 4 }}>{joinError}</div>
        ) : null}
      </div>
      {actionable ? (
        <Button
          variant="primary" size="sm" disabled={joining}
          aria-label={t('groupInvite.actionLabel', { action: actionLabel, group: name })}
          onClick={onJoin}
          className="shrink-0"
        >
          {joining ? busyLabel : actionLabel}
        </Button>
      ) : inactiveAction === 'button' ? (
        <Button
          variant="secondary" size="sm" disabled
          aria-label={t('groupInvite.actionLabel', { action: stateLabel[state], group: name })}
          className="shrink-0"
        >
          {stateLabel[state]}
        </Button>
      ) : (
        <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', flexShrink: 0 }}>{stateLabel[state]}</span>
      )}
    </div>
  )
}
