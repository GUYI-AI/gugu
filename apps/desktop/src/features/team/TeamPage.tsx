import { TeamTopupDialog } from './TeamTopupDialog'
import { useDeferredValue, useState } from 'react'
import { skipToken, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SearchField } from '@/components/ui/SearchField'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { MoreHorizontal } from '@/lib/icons'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { creditUnits } from '@gugu/core/billing/creditAmount'
import { teamKeys, useTeamApi, useTeamSession } from './context'
import { teamFailureCopy, teamRoleLabel } from './copy'
import { TeamApiError } from './errors'
import { TeamAsyncState, TeamCheckbox, TeamDialog } from './TeamPrimitives'
import { CapDialog, type CapTarget } from './TeamCredits'
import { TeamMembers, TeamMemberActionsDialog } from './TeamMembers'
import { TeamInviteDialog } from './TeamMemberCommands'
import type { TeamDirectoryUsageMember, TeamMember } from './types'
import './team.css'

export function TeamPage({ onTopUp }: {
  onTopUp?: () => void
}) {
  const { t } = useTranslation('team'), { user } = useAuth(), session = useTeamSession(), api = useTeamApi(), cache = useQueryClient()
  const context = session.context, admin = session.status === 'ready' && context?.role !== 'member'
  const [topup, setTopup] = useState(false)
  const [query, setQuery] = useState(''), [invite, setInvite] = useState(false), [manage, setManage] = useState(false)
  const [bulk, setBulk] = useState(false), [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [actions, setActions] = useState<TeamDirectoryUsageMember | null>(null), [editing, setEditing] = useState<CapTarget[] | null>(null)
  const search = useDeferredValue(query.trim())
  const result = useInfiniteQuery({
    queryKey: [...teamKeys.account(user?.id ?? ''), 'settings-directory', context?.team_id, context?.membership_revision, context?.role, search],
    initialPageParam: null as string | null, enabled: session.status === 'ready', refetchInterval: 30_000,
    queryFn: context ? async ({ pageParam, signal }) => {
      const page = await api.directorySummary({ query: search || undefined, cursor: pageParam ?? undefined, limit: 50 }, signal)
      if (page.team_id !== context.team_id) throw new TeamApiError('team_identity_required')
      return page
    } : skipToken,
    getNextPageParam: page => page.next_cursor ?? undefined,
  })
  if (session.status !== 'ready' || !context) return null
  const summary = result.data?.pages[0], rows = result.data?.pages.flatMap(page => page.members) ?? []
  const targets = (members: TeamDirectoryUsageMember[]): CapTarget[] => members.map(member => ({
    member_id: member.id, name: member.name, used_credits: member.used_credits, cap_credits: member.cap_credits,
    cap_revision: member.cap_revision, scope: summary!.scope,
  }))
  const refresh = async () => { setSelected(new Set()); await cache.invalidateQueries({ queryKey: teamKeys.account(user!.id) }) }
  const selectedRows = rows.filter(member => selected.has(member.id))
  const own = rows.find(member => member.identity_id === user?.id)
  const stop = summary && creditUnits(summary.team_balance_credits) <= 0n ? 'team_credits_exhausted' : own?.stop_reason
  const managed: TeamMember | null = actions?.email ? { ...actions, identity_id: actions.identity_id, state: 'active', email: actions.email } : null
  return <div className="gg-team-settings" data-testid="team-page">
    <section className="gg-team-settings-summary">
      <Avatar name={context.team_name} seed={context.team_id} variant="group" size="md" />
      <div className="gg-team-settings-name"><h2>{summary?.team_name ?? context.team_name}</h2>
        {summary && <span>{t('memberCount', { count: summary.total_count })}</span>}</div>
      {summary && <div className="gg-team-settings-balance"><strong>{formatCredits(summary.team_balance_credits)}</strong><small>{t('remainingCredits')}</small></div>}
      {admin && <Button variant="primary" onClick={onTopUp ?? (() => setTopup(true))}>{t('recharge')}</Button>}
    </section>
    {stop && <p role="status" className="gg-team-muted">{teamFailureCopy(stop, t)}</p>}
    <div className="gg-team-settings-toolbar"><h2>{t('memberList')}{summary && <span> {summary.total_count}</span>}</h2>
      <SearchField placeholder={t(admin ? 'searchNameNumberOrEmail' : 'searchNameOrNumber')} value={query}
        onChange={event => { setQuery(event.target.value); setSelected(new Set()) }} />
      {admin && <Button onClick={() => setInvite(true)}>{t('addMember')}</Button>}
    </div>
    {admin && <div className="gg-team-settings-management">
      <Button variant="ghost" onClick={() => { setBulk(!bulk); setSelected(new Set()) }}>{t(bulk ? 'cancel' : 'bulkCap')}</Button>
      {bulk ? <><span>{t('bulkLimit')}</span><Button disabled={!selectedRows.length} onClick={() => setEditing(targets(selectedRows))}>{t('setCap')}</Button></>
        : <Button variant="ghost" onClick={() => setManage(true)}>{t('manageAccounts')}</Button>}
    </div>}
    {admin && bulk && rows.length > 0 && <div className="gg-team-checkbox-label">
      <TeamCheckbox checked={selectedRows.length === rows.length} disabled={rows.length > 100} label={t('selectLoaded')}
        onChange={checked => setSelected(checked ? new Set(rows.map(row => row.id)) : new Set())} /><span>{t('selectLoaded')}</span>
    </div>}
    <div className="gg-team-settings-list" aria-busy={result.isFetching || query.trim() !== search}
      onScroll={event => {
        const list = event.currentTarget
        if (list.scrollHeight - list.scrollTop - list.clientHeight < 80 && result.hasNextPage && !result.isFetching && !result.isError)
          void result.fetchNextPage()
      }}>
      {result.isPending || result.isError ? <TeamAsyncState pending={result.isPending} error={result.error} retry={() => { void result.refetch() }} />
        : rows.length === 0 ? <PaneEmptyState caption={t(search ? 'noResults' : 'noMembers')} />
        : rows.map(member => <div className="gg-team-settings-member gg-team-person-row" data-selecting={admin && bulk ? '' : undefined} key={member.id}>
          {admin && bulk && <TeamCheckbox checked={selected.has(member.id)} disabled={!selected.has(member.id) && selected.size >= 100}
            label={t('selectMember', { name: member.name })} onChange={checked => setSelected(previous => {
              const next = new Set(previous); if (checked) next.add(member.id); else next.delete(member.id); return next
            })} />}
          <div className="gg-team-settings-avatar"><Avatar name={member.name} avatarUrl={member.avatar} seed={member.identity_id} isAgent={false} size="sm" /></div>
          <div className="gg-team-settings-person"><span>{member.name}</span><small>{admin ? member.email : member.gugu_number === null ? t('guguNumberUnassigned') : t('guguNumberValue', { number: member.gugu_number })}</small></div>
          <div className="gg-team-settings-usage"><span>{t('monthRowUsage', { used: formatCredits(member.used_credits), cap: member.cap_credits === null ? t('uncapped') : formatCredits(member.cap_credits) })}</span>
            {member.cap_credits !== null && <progress aria-label={t('memberUsage', { name: member.name })}
              value={creditUnits(member.cap_credits) === 0n ? 1 : Math.min(1, Number(member.used_credits) / Number(member.cap_credits))} max={1} />}</div>
          <span className="gg-team-settings-role">{teamRoleLabel(member.role, t)}</span>
          {admin && member.email && <IconButton className="gg-team-settings-actions" size="sm" aria-label={t('manageMember', { name: member.name })} onClick={() => setActions(member)}><MoreHorizontal /></IconButton>}
        </div>)}
      {result.hasNextPage && !result.isError && <Button disabled={result.isFetching} onClick={() => { void result.fetchNextPage() }}>{t('more')}</Button>}
    </div>
    {admin && topup && <TeamTopupDialog key={context.team_id} onClose={() => setTopup(false)} onSettled={refresh} />}
    {admin && invite && <TeamInviteDialog onClose={() => setInvite(false)} onSaved={refresh} />}
    {admin && manage && <TeamDialog title={t('members')} onClose={() => setManage(false)}><TeamMembers /></TeamDialog>}
    {admin && managed && actions && <TeamMemberActionsDialog member={managed} onClose={() => setActions(null)} onChanged={refresh}
      onCap={() => { setEditing(targets([actions])); setActions(null) }} />}
    {admin && editing && <CapDialog targets={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
  </div>
}
