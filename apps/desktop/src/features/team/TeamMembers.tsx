import { useState } from 'react'
import { skipToken, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { teamKeys, useTeamApi, useTeamSession } from './context'
import { teamErrorCopy, teamRoleLabel } from './copy'
import { TeamAsyncState, TeamDialog } from './TeamPrimitives'
import { TeamDisableDialog, TeamEmailDialog, TeamInviteDialog } from './TeamMemberCommands'
import { useTeamCommandKey } from './operations'
import type { TeamMember, TeamMemberState } from './types'

function MemberDialog({ member, onClose, onChanged, onEmail, onDisable }: {
  member: TeamMember; onClose: () => void; onChanged: () => Promise<void>; onEmail: () => void; onDisable: () => void
}) {
  const { t } = useTranslation('team'), session = useTeamSession(), api = useTeamApi(), key = useTeamCommandKey()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
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
      {member.state === 'active' && canManage && <Button disabled={busy} onClick={onEmail}>{t('changeLoginEmail')}</Button>}
      {member.state === 'active' && role === 'superadmin' && member.role !== 'superadmin' && <Button disabled={busy} onClick={() => { void update('role') }}>{t(member.role === 'admin' ? 'revokeAdmin' : 'appointAdmin')}</Button>}
      {canManage && member.state === 'active' && <Button disabled={busy} onClick={onDisable}>{t('disable')}</Button>}
      {canManage && member.state === 'disabled' && <Button disabled={busy} onClick={() => { void update('restore') }}>{t('restore')}</Button>}
      {member.role === 'superadmin' && <p>{t('creatorProtected')}</p>}
    </div>}
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}

export function TeamMembers() {
  const { t } = useTranslation('team'), api = useTeamApi(), session = useTeamSession(), { user } = useAuth(), cache = useQueryClient()
  const [state, setState] = useState<TeamMemberState>('active'), [invite, setInvite] = useState(false)
  const [selected, setSelected] = useState<{ member: TeamMember; action: 'details' | 'email' | 'disable' } | null>(null)
  const context = session.context, admin = session.status === 'ready' && context?.role !== 'member'
  const result = useInfiniteQuery({ queryKey: [...teamKeys.account(user?.id ?? ''), 'manage-members', context?.team_id, state],
    initialPageParam: null as string | null, queryFn: admin ? ({ pageParam, signal }) => api.members({ state, cursor: pageParam ?? undefined, limit: 50 }, signal) : skipToken,
    getNextPageParam: page => page.next_cursor ?? undefined })
  const refresh = async () => { await cache.invalidateQueries({ queryKey: teamKeys.account(user!.id) }) }
  if (!admin) return <PaneEmptyState caption={t('forbidden')} />
  return <>
    <div className="gg-team-section-heading"><SegmentedTabs value={state} onChange={setState} ariaLabel={t('members')}
      items={(['active', 'disabled', 'invited'] as const).map(value => ({ value, label: t(value) }))} />
      <Button onClick={() => setInvite(true)}>{t('invite')}</Button></div>
    {result.isPending || result.isError ? <TeamAsyncState pending={result.isPending} error={result.error} retry={() => { void result.refetch() }} />
      : result.data.pages.some(page => page.members.length) ? <div className="gg-team-list">{result.data.pages.flatMap(page => page.members).map(member =>
        <ListRow key={member.id} role="button" tabIndex={0} className="gg-team-person-row" onClick={() => setSelected({ member, action: 'details' })}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected({ member, action: 'details' }) } }}
          leading={<Avatar name={member.name} seed={member.identity_id ?? member.id} size="md" />} title={member.name} subtitle={member.email}
          trailing={<span className="gg-team-muted">{teamRoleLabel(member.role, t)}</span>} />)}</div> : <PaneEmptyState caption={t('noMembers')} />}
    {result.hasNextPage && <Button disabled={result.isFetchingNextPage} onClick={() => { void result.fetchNextPage() }}>{t('more')}</Button>}
    {invite && <TeamInviteDialog onClose={() => setInvite(false)} onSaved={refresh} />}
    {selected?.action === 'details' && <MemberDialog member={selected.member} onClose={() => setSelected(null)} onChanged={refresh}
      onEmail={() => setSelected({ ...selected, action: 'email' })} onDisable={() => setSelected({ ...selected, action: 'disable' })} />}
    {selected?.action === 'email' && <TeamEmailDialog member={selected.member} onClose={() => setSelected(null)} onSaved={refresh} />}
    {selected?.action === 'disable' && <TeamDisableDialog member={selected.member} candidates={result.data?.pages.flatMap(page => page.members) ?? []}
      onMore={result.hasNextPage ? () => { void result.fetchNextPage() } : undefined} loadingMore={result.isFetchingNextPage}
      onClose={() => setSelected(null)} onSaved={refresh} />}
  </>
}
