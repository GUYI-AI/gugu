import { skipToken, useInfiniteQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/store/auth'
import { Button } from '@/components/ui/Button'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { teamKeys, useTeamApi, useTeamSession } from './context'
import { TeamAsyncState } from './TeamPrimitives'
import { teamFailureCopy } from './copy'
import type { TeamStopReason } from './types'

export function TeamPauseState({ reason, onUsage, onContact, onTopUp }: { reason: TeamStopReason; onUsage: () => void; onContact?: () => void; onTopUp?: () => void }) {
  const { t } = useTranslation('team')
  return <div className="gg-team-pause" role="status"><h2>{t(reason === 'team_credits_exhausted' ? 'poolStopTitle' : 'capStopTitle')}</h2>
    <p>{teamFailureCopy(reason, t)}</p><div>
      <Button onClick={onUsage}>{t('viewUsage')}</Button>
      {reason === 'team_credits_exhausted' && onTopUp ? <Button variant="primary" onClick={onTopUp}>{t('topUp')}</Button>
        : onContact && <Button variant="primary" onClick={onContact}>{t('contactAdmin')}</Button>}
    </div></div>
}

export function TeamUsage({ onPause }: { onPause: (reason: TeamStopReason) => void }) {
  const { t, i18n } = useTranslation('team')
  const api = useTeamApi(), session = useTeamSession(), { user } = useAuth(), context = session.context
  const query = useInfiniteQuery({
    queryKey: [...teamKeys.account(user?.id ?? ''), 'my-usage', context?.team_id, context?.scope.label], initialPageParam: null as string | null,
    queryFn: context && user ? ({ pageParam, signal }) => api.myUsage({ cursor: pageParam ?? undefined, limit: 50 }, signal) : skipToken,
    enabled: session.status === 'ready', getNextPageParam: page => page.next_cursor ?? undefined,
  })
  if (query.isPending || query.isError) return <TeamAsyncState pending={query.isPending} error={query.error} retry={() => { void query.refetch() }} />
  const usage = query.data.pages[0], records = query.data.pages.flatMap(page => page.records)
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
  return <div className="gg-team-usage">
    <div className="gg-team-my-summary"><small>{t('monthUsed')}</small><strong>{formatCredits(usage.used_credits)}</strong><span>{usage.scope.label}</span></div>
    <div className="gg-team-value-row"><span>{t('monthCap')}</span><span>{usage.cap_credits === null ? t('noCap') : formatCredits(usage.cap_credits)}</span></div>
    <div className="gg-team-value-row"><span>{t('monthRemaining')}</span><span>{usage.headroom_credits === null ? t('unlimited') : formatCredits(usage.headroom_credits)}</span></div>
    <p className="gg-team-muted">{t('monthReset')} {t('sharedPoolNote')}</p>
    {usage.stop_reason && <Button onClick={() => onPause(usage.stop_reason!)}>{t('pauseReason')}</Button>}
    <h2>{t('usageRecords')}</h2>
    {records.length ? <div className="gg-team-list">{records.map(row => <div className="gg-team-usage-record" key={row.id}>
      <span><b>{row.label}</b><small>{date.format(new Date(row.occurred_at))}</small></span><span>{formatCredits(row.credits)}</span>
    </div>)}</div> : <PaneEmptyState caption={t('noUsage')} />}
    {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage() }}>{t('more')}</Button>}
  </div>
}
