import { useState } from 'react'
import { refreshTag } from '@/lib/replica'
import { useReplicaPages } from '@/lib/replicaPages'
import { RefreshFailed } from '@/components/ui/RefreshFailed'
import { TEAM, teamApiKey, teamMembersPage } from './replicas'
import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { useTeamApi, useTeamSession } from './context'
import { teamErrorCopy, teamRoleLabel } from './copy'
import { TeamDialog, TeamReadingState } from './TeamPrimitives'
import { TeamDisableDialog, TeamEmailDialog, TeamInviteDialog } from './TeamMemberCommands'
import { useTeamCommandKey } from './operations'
import { useTeamDisableIntent } from './disableIntents'
import type { TeamMember, TeamMemberState } from './types'

function MemberDialog({ member, onClose, onChanged, onEmail, onDisable, onCap }: {
  member: TeamMember; onClose: () => void; onChanged: () => Promise<void>; onEmail: () => void; onDisable: () => void; onCap?: () => void
}) {
  const { t } = useTranslation('team'), session = useTeamSession(), api = useTeamApi(), key = useTeamCommandKey()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const disableIntent = useTeamDisableIntent(member.id)
  const role = session.context?.role
  const canManage = member.role !== 'superadmin' && (role === 'superadmin' || (role === 'admin' && member.role === 'member'))
  async function update(action: 'role' | 'restore') {
    setBusy(true); setError('')
    const command = { action, id: member.id, revision: member.revision, role: member.role === 'admin' ? 'member' as const : 'admin' as const }
    try {
      if (action === 'role') await api.setRole(member.id, command.role, member.revision, key(command))
      else await api.restore(member.id, member.revision, key(command))
      setNotice(t(action === 'role' ? 'roleUpdated' : 'restored')); await onChanged()
    } catch (cause) { setError(teamErrorCopy(cause, t)) }
    finally { setBusy(false) }
  }
  return <TeamDialog title={t('manageMember', { name: member.name })} onClose={() => { if (!busy) onClose() }}>
    <p>{member.email}</p><p className="gg-team-muted">{teamRoleLabel(member.role, t)}</p>
    {notice ? <p role="status">{notice}</p> : <div className="gg-team-command-list">
      {onCap && <Button disabled={busy} onClick={onCap}>{t('setCap')}</Button>}
      {member.state === 'active' && canManage && !disableIntent.pending && <Button disabled={busy} onClick={onEmail}>{t('changeLoginEmail')}</Button>}
      {member.state === 'active' && role === 'superadmin' && member.role !== 'superadmin' && !disableIntent.pending && <Button disabled={busy} onClick={() => { void update('role') }}>{t(member.role === 'admin' ? 'revokeAdmin' : 'appointAdmin')}</Button>}
      {canManage && (disableIntent.pending || member.state === 'active') && <Button disabled={busy} onClick={onDisable}>{t(disableIntent.pending ? 'checkDisable' : 'disable')}</Button>}
      {canManage && member.state === 'disabled' && !disableIntent.pending && <Button disabled={busy} onClick={() => { void update('restore') }}>{t('restore')}</Button>}
      {member.role === 'superadmin' && <p>{t('creatorProtected')}</p>}
    </div>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}

export function TeamMemberActionsDialog({ member, onClose, onChanged, onCap }: {
  member: TeamMember; onClose: () => void; onChanged: () => Promise<void>; onCap: () => void
}) {
  const { t } = useTranslation('team'), api = useTeamApi(), session = useTeamSession()
  const admin = session.status === 'ready' && session.context?.role !== 'member'
  const [action, setAction] = useState<'details' | 'email' | 'disable'>('details')
  // Whom a disabled member's work is handed to: the team's active members, read once the disable step opens.
  const candidates = useReplicaPages(teamMembersPage,
    admin && action === 'disable' && session.context ? [teamApiKey(api), session.context.team_id, 'active' as const] : null, page => page.next_cursor)
  if (!admin) return <PaneEmptyState caption={t('forbidden')} />
  if (action === 'email') return <TeamEmailDialog member={member} onClose={onClose} onSaved={onChanged} />
  if (action === 'disable') {
    if (candidates.first.state !== 'value') return <TeamDialog title={t('disable')} onClose={onClose}>
      <TeamReadingState reading={candidates.first} />
    </TeamDialog>
    return <TeamDisableDialog member={member} candidates={candidates.pages.flatMap(page => page.members)}
      onMore={candidates.more ?? undefined} loadingMore={candidates.loadingMore} onClose={onClose} onSaved={onChanged} />
  }
  return <MemberDialog member={member} onClose={onClose} onChanged={onChanged} onCap={onCap}
    onEmail={() => setAction('email')} onDisable={() => setAction('disable')} />
}

function ManagedMemberRow({ member, onSelect }: { member: TeamMember; onSelect: () => void }) {
  const { t } = useTranslation('team'), intent = useTeamDisableIntent(member.id)
  return <ListRow role="button" tabIndex={0} className="gg-team-person-row" onClick={onSelect}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }}
    leading={<Avatar name={member.name} seed={member.identity_id ?? member.id} isAgent={false} size="md" />} title={member.name} subtitle={member.email}
    trailing={<span className="gg-team-muted">{intent.pending ? t('disableUnconfirmed') : teamRoleLabel(member.role, t)}</span>} />
}

export function TeamMembers() {
  const { t } = useTranslation('team'), api = useTeamApi(), session = useTeamSession()
  const [state, setState] = useState<Exclude<TeamMemberState, 'provisioning'>>('active'), [invite, setInvite] = useState(false)
  const [selected, setSelected] = useState<{ member: TeamMember; action: 'details' | 'email' | 'disable' } | null>(null)
  const context = session.context, admin = session.status === 'ready' && context?.role !== 'member'
  const list = useReplicaPages(teamMembersPage, admin && context ? [teamApiKey(api), context.team_id, state] : null, page => page.next_cursor)
  const members = list.pages.flatMap(page => page.members)
  const refresh = async () => { await refreshTag(TEAM) }
  if (!admin) return <PaneEmptyState caption={t('forbidden')} />
  return <>
    <div className="gg-team-section-heading"><SegmentedTabs value={state} onChange={setState} ariaLabel={t('members')}
      items={(['active', 'disabled', 'invited'] as const).map(value => ({ value, label: t(value) }))} />
      <Button onClick={() => setInvite(true)}>{t('invite')}</Button></div>
    <RefreshFailed reading={list.first} />
    {list.first.state !== 'value' ? <TeamReadingState reading={list.first} />
      : members.length ? <div className="gg-team-list">{members.map(member =>
        <ManagedMemberRow key={member.id} member={member} onSelect={() => setSelected({ member, action: 'details' })} />)}</div> : <PaneEmptyState caption={t('noMembers')} />}
    {list.moreFailed && <RefreshFailed reading={list.moreFailed} />}
    {(list.more || list.loadingMore) && <Button disabled={list.loadingMore} onClick={() => list.more?.()}>{t('more')}</Button>}
    {invite && <TeamInviteDialog onClose={() => setInvite(false)} onSaved={refresh} />}
    {selected?.action === 'details' && <MemberDialog member={selected.member} onClose={() => setSelected(null)} onChanged={refresh}
      onEmail={() => setSelected({ ...selected, action: 'email' })} onDisable={() => setSelected({ ...selected, action: 'disable' })} />}
    {selected?.action === 'email' && <TeamEmailDialog member={selected.member} onClose={() => setSelected(null)} onSaved={refresh} />}
    {selected?.action === 'disable' && <TeamDisableDialog member={selected.member} candidates={members}
      onMore={list.more ?? undefined} loadingMore={list.loadingMore}
      onClose={() => setSelected(null)} onSaved={refresh} />}
  </>
}
