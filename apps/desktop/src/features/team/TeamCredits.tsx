import { useState } from 'react'
import { skipToken, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { addCreditDecimals, creditDecimal } from '@gugu/core/billing/creditAmount'
import { teamKeys, useTeamApi, useTeamSession } from './context'
import { teamErrorCopy } from './copy'
import { TeamAsyncState, TeamCheckbox, TeamDialog } from './TeamPrimitives'
import { parseTeamCap, useTeamCommandKey } from './operations'
import { TeamApiError } from './errors'
import type { TeamMember, TeamMemberUsage } from './types'

type CapTarget = TeamMemberUsage & { name: string }

function CapDialog({ targets, onClose, onSaved }: { targets: CapTarget[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useTranslation('team'), api = useTeamApi(), key = useTeamCommandKey()
  const initial = targets.length === 1 ? targets[0].cap_credits : null
  const [unlimited, setUnlimited] = useState(initial === null), [amount, setAmount] = useState(initial ?? '')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false)
  async function save() {
    let cap
    try { cap = parseTeamCap(amount, unlimited) } catch { setError(t('capInvalid')); return }
    const members = targets.map(target => ({ member_id: target.member_id, cap_credits: cap, expected_revision: target.cap_revision }))
    setBusy(true); setError('')
    try { await api.setCaps(members, key(members)); await onSaved(); onClose() }
    catch (cause) {
      setError(teamErrorCopy(cause, t))
      if (cause instanceof TeamApiError && cause.code === 'version_conflict') { setStale(true); await onSaved() }
    }
    finally { setBusy(false) }
  }
  return <TeamDialog title={targets.length === 1 ? t('setCapFor', { name: targets[0].name }) : t('bulkCap')}
    onClose={() => { if (!busy) onClose() }} actions={<>
      <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      {!stale && <Button variant="primary" disabled={busy} onClick={() => { void save() }}>{t('save')}</Button>}
    </>}>
    <p>{targets.length === 1 ? t('capCurrent', { name: targets[0].name, credits: formatCredits(targets[0].used_credits) }) : t('capBulkHint', { count: targets.length })}</p>
    <div className="gg-team-checkbox-label"><TeamCheckbox checked={unlimited} onChange={setUnlimited} label={t('noCapSetting')} disabled={busy} /><span>{t('noCapSetting')}</span></div>
    <Field.Root disabled={busy || unlimited}><Field.Label>{t('capAmount')}</Field.Label>
      <Field.Input inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} disabled={busy || unlimited} />
      <Field.Description>{t('capHint')}</Field.Description></Field.Root>
    {error && <p role="alert" className="gg-team-error">{error}</p>}
  </TeamDialog>
}

export function TeamCredits({ onTopUp }: { onTopUp: () => void }) {
  const { t } = useTranslation('team'), { user } = useAuth(), session = useTeamSession(), api = useTeamApi(), cache = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() => new Set()), [editing, setEditing] = useState<CapTarget[] | null>(null)
  const context = session.context, admin = session.status === 'ready' && context?.role !== 'member'
  const key = [...teamKeys.account(user?.id ?? ''), 'billing-summary', context?.team_id, context?.scope.label]
  const summary = useQuery({ queryKey: key, queryFn: admin ? ({ signal }) => api.summary(signal) : skipToken })
  const people = useInfiniteQuery({ queryKey: [...teamKeys.account(user?.id ?? ''), 'cap-members', context?.team_id],
    initialPageParam: { active: null, disabled: null, invited: null } as { active?: string | null; disabled?: string | null; invited?: string | null },
    queryFn: admin ? async ({ pageParam, signal }) => {
      const [active, disabled, invited] = await Promise.all([
        pageParam.active !== undefined ? api.members({ state: 'active', limit: 50, cursor: pageParam.active ?? undefined }, signal) : null,
        pageParam.disabled !== undefined ? api.members({ state: 'disabled', limit: 50, cursor: pageParam.disabled ?? undefined }, signal) : null,
        pageParam.invited !== undefined ? api.members({ state: 'invited', limit: 50, cursor: pageParam.invited ?? undefined }, signal) : null,
      ])
      return { members: [...(active?.members ?? []), ...(disabled?.members ?? []), ...(invited?.members ?? [])],
        next: { active: active?.next_cursor ?? undefined, disabled: disabled?.next_cursor ?? undefined, invited: invited?.next_cursor ?? undefined } }
    } : skipToken,
    getNextPageParam: page => page.next.active || page.next.disabled || page.next.invited ? page.next : undefined })
  if (!admin) return <PaneEmptyState caption={t('forbidden')} />
  if (summary.isPending || people.isPending || summary.isError || people.isError) return <TeamAsyncState pending={summary.isPending || people.isPending}
    error={summary.error ?? people.error} retry={() => { void summary.refetch(); void people.refetch() }} />
  const names = new Map<string, TeamMember>(people.data.pages.flatMap(page => page.members).map(member => [member.id, member]))
  const rows = summary.data.members.filter(member => names.has(member.member_id)).map(member => ({ ...member, name: names.get(member.member_id)!.name }))
  const selectedRows = rows.filter(member => selected.has(member.member_id)), allSelected = rows.length > 0 && selectedRows.length === rows.length
  const refresh = async () => { await cache.invalidateQueries({ queryKey: teamKeys.account(user!.id) }); setSelected(new Set()) }
  const total = summary.data.members.reduce((sum, member) => addCreditDecimals(sum, member.used_credits), creditDecimal('0'))
  return <div className="gg-team-credits">
    <div className="gg-team-section-heading"><div className="gg-team-credit-totals"><div className="gg-team-my-summary"><small>{t('remainingCredits')}</small><strong>{formatCredits(summary.data.team_balance_credits)}</strong></div>
      <div className="gg-team-my-summary"><small>{t('monthUsed')}</small><strong>{formatCredits(total)}</strong></div></div>
      <Button onClick={onTopUp}>{t('topUp')}</Button></div>
    <p className="gg-team-muted">{t('billingLoginHint')}</p>
    <div className="gg-team-section-heading"><h2>{t('memberUsageCaps')}</h2><Button disabled={!selectedRows.length} onClick={() => setEditing(selectedRows)}>{t('bulkCap')}</Button></div>
    <div className="gg-team-cap-heading"><TeamCheckbox checked={allSelected} label={t('selectAll')} onChange={checked => setSelected(checked ? new Set(rows.map(row => row.member_id)) : new Set())} />
      <span>{selectedRows.length ? t('selected', { count: selectedRows.length }) : t('directory')}</span><span>{t('monthUsed')}</span><span>{t('monthCap')}</span><span /></div>
    <div className="gg-team-list">{rows.map(row => <div className="gg-team-cap-row" key={row.member_id}>
      <TeamCheckbox checked={selected.has(row.member_id)} label={t('selectMember', { name: row.name })} onChange={checked => setSelected(previous => {
        const next = new Set(previous); if (checked) next.add(row.member_id); else next.delete(row.member_id); return next
      })} />
      <div className="gg-team-person"><Avatar name={row.name} seed={names.get(row.member_id)!.identity_id ?? row.member_id} size="sm" /><span>{row.name}</span>
        {names.get(row.member_id)!.state !== 'active' && <small className="gg-team-muted">{t(names.get(row.member_id)!.state)}</small>}</div>
      <span>{formatCredits(row.used_credits)}</span><span>{row.cap_credits === null ? t('noCap') : formatCredits(row.cap_credits)}</span>
      <Button variant="ghost" onClick={() => setEditing([row])}>{t('setCap')}</Button>
    </div>)}</div>
    {people.hasNextPage && <Button disabled={people.isFetchingNextPage} onClick={() => { void people.fetchNextPage() }}>{t('more')}</Button>}
    <p className="gg-team-muted">{t('capHint')} {t('sharedPoolNote')}</p>
    {editing && <CapDialog targets={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
  </div>
}
