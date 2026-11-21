import { useGroupDisplayName } from '../../hooks/useGroupDisplayName'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useContactsStore } from '../../store/contactsContext'
import { useChatStore } from '../../store/chatContext'
import { isGroupInvitationNote } from '@gugu/core/cloud/groupChat'
import { decideGroupInvitation, type GroupInvitation } from '../../lib/groupInvitations'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { Avatar } from '../Avatar'
import { DetailFooter, RequestRow } from '../requests/RequestRow'
import { RequestDetailSheet } from '../requests/RequestDetailSheet'

const invitationLog = rendererLogger('contacts/group-invitations')

export function GroupInvitationRow({ invitation }: { invitation: GroupInvitation }) {
  const { t } = useTranslation('contacts')
  const { refreshRequests } = useContactsStore()
  const groupName = useGroupDisplayName({ id: invitation.chat_id, name: invitation.group_name })
  const { refreshChats } = useChatStore('refreshChats')
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function decide(accept: boolean) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await decideGroupInvitation(invitation.id, accept)
      if (accept) {
        await refreshChats()
      }
      await refreshRequests()
    } catch (cause) {
      invitationLog.error({ invitationId: invitation.id, error: String(cause) }, 'group invitation decision failed')
      setError(cause instanceof Error && (cause.message === 'Group member limit reached' || cause.message === 'member_limit_reached')
        ? t('groupInvitations.full')
        : messageForUser(cause))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // 同一种请求行(头像 · 谁 · 一行说明 · 行尾同意 / 拒绝或灰字状态),点行看详情:与好友申请、入群申请一样。
  const invitedLine = t(invitation.inviter_type === 'agent' ? 'groupInvitations.invitedBy' : 'groupInvitations.invitedByHuman', { inviter: invitation.inviter_name, owner: invitation.inviter_owner_name, group: groupName })
  const joinsLine = t(invitation.invitee_type === 'human' ? 'groupInvitations.humanJoins' : invitation.owner_will_join ? 'groupInvitations.ownerJoins' : 'groupInvitations.agentJoins')
  const note = isGroupInvitationNote(invitation.message) ? null : invitation.message?.trim() || null
  const status = invitation.status === 'pending' ? null : t(invitation.status === 'accepted' ? 'groupJoinRequests.statusAccepted' : 'groupJoinRequests.statusRejected')
  const inviter = { id: invitation.inviter_user_id, display_name: invitation.inviter_name, avatar: null, gugu_number: null, type: invitation.inviter_type === 'agent' ? 'agent' as const : 'human' as const }
  const act = (accept: boolean) => () => { setOpen(false); void decide(accept) }
  return (
    <div data-testid="group-invitation" data-invitation-id={invitation.id}>
      <RequestRow
        avatar={<Avatar name={invitation.inviter_name} seed={invitation.inviter_user_id} isAgent={invitation.inviter_type === 'agent'} size="sm" />}
        name={invitation.inviter_name}
        // 同意按钮就在行上:谁会进群(你和 Agent 一同 / 只有 Agent / 你)这句同意前必须看得到,不能只放进详情。
        sub={[invitedLine, invitation.invitee_type === 'agent' ? t('groupInvitations.agent', { name: invitation.invitee_name }) : null, invitation.status === 'pending' ? joinsLine : null, note].filter(Boolean).join(' · ')}
        status={status}
        onOpen={() => setOpen(true)}
        selected={open}
        loading={busy}
        onAccept={act(true)}
        onReject={act(false)}
        acceptLabel={t('groupInvitations.accept')}
        rejectLabel={t('groupInvitations.reject')}
        acceptData={{ 'data-testid': 'group-invitation-accept' }}
        rejectData={{ 'data-testid': 'group-invitation-reject' }}
        rowData={{ 'data-request-status': invitation.status }}
      />
      {error ? <div role="alert" className="!px-2 !pb-2 text-[length:var(--font-caption)] text-[var(--danger-fg)]">{error}</div> : null}
      {open ? (
        <RequestDetailSheet
          peer={inviter}
          context={invitation.status === 'pending' ? `${invitedLine}。${joinsLine}` : invitedLine}
          message={note}
          onClose={() => setOpen(false)}
          footer={<DetailFooter status={status} loading={busy} onAccept={act(true)} onReject={act(false)} acceptLabel={t('groupInvitations.accept')} rejectLabel={t('groupInvitations.reject')} />}
        />
      ) : null}
    </div>
  )
}

export function GroupInvitationsPanel() {
  const { t } = useTranslation('contacts')
  const { groupInvitations, requestsStatus } = useContactsStore()
  if (requestsStatus === 'idle' || requestsStatus === 'loading') return <p role="status" className="p-4 text-sm">{t('common.loading')}</p>
  if (!groupInvitations.length) {
    return requestsStatus === 'ready' ? <p className="px-4 py-12 text-center text-sm text-[var(--text-secondary)]">{t('groupInvitations.empty')}</p> : null
  }
  return <>{groupInvitations.map((invitation) => <GroupInvitationRow key={invitation.id} invitation={invitation} />)}</>
}
