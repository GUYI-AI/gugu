import { useReplicaPages } from '@/lib/replicaPages'
import { RefreshFailed } from '@/components/ui/RefreshFailed'
import { teamUsagePage } from './replicas'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { useTeamSession } from './context'
import { TeamReadingState } from './TeamPrimitives'
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
  const session = useTeamSession(), context = session.context
  const list = useReplicaPages(teamUsagePage, session.status === 'ready' && context ? [context.team_id, context.scope.label] : null,
    page => page.next_cursor)
  if (list.first.state !== 'value') return <TeamReadingState reading={list.first} />
  const usage = list.first.value, records = list.pages.flatMap(page => page.records)
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' })
  return <div className="gg-team-usage">
    <RefreshFailed reading={list.first} />
    <div className="gg-team-my-summary"><small>{t('monthUsed')}</small><strong>{formatCredits(usage.used_credits)}</strong><span>{usage.scope.label}</span></div>
    <div className="gg-team-value-row"><span>{t('monthCap')}</span><span>{usage.cap_credits === null ? t('noCap') : formatCredits(usage.cap_credits)}</span></div>
    <div className="gg-team-value-row"><span>{t('monthRemaining')}</span><span>{usage.headroom_credits === null ? t('unlimited') : formatCredits(usage.headroom_credits)}</span></div>
    <p className="gg-team-muted">{t('monthReset')} {t('sharedPoolNote')}</p>
    {usage.stop_reason && <Button onClick={() => onPause(usage.stop_reason!)}>{t('pauseReason')}</Button>}
    <h2>{t('usageRecords')}</h2>
    {records.length ? <div className="gg-team-list">{records.map(row => <div className="gg-team-usage-record" key={row.id}>
      <span><b>{row.label}</b><small>{date.format(new Date(row.occurred_at))}</small></span><span>{formatCredits(row.credits)}</span>
    </div>)}</div> : <PaneEmptyState caption={t('noUsage')} />}
    {list.moreFailed && <RefreshFailed reading={list.moreFailed} />}
    {(list.more || list.loadingMore) && <Button disabled={list.loadingMore} onClick={() => list.more?.()}>{t('more')}</Button>}
  </div>
}
