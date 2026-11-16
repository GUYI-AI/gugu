import { skipToken, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { useAuth } from '@/store/auth'
import { formatCredits } from '@/lib/billing/spendingPowerCopy'
import { teamKeys, useTeamApi, useTeamSession } from './context'
import { teamRoleLabel } from './copy'
import { TeamAsyncState } from './TeamPrimitives'
import { TeamPersonRow } from './TeamDirectory'
import type { TeamDirectoryMember } from './types'

export function TeamOverview({ onUsage, onDirectory, onMember }: { onUsage: () => void; onDirectory: () => void; onMember: (member: TeamDirectoryMember) => void }) {
  const { t } = useTranslation('team'), { user } = useAuth(), session = useTeamSession(), api = useTeamApi()
  const context = session.context
  const people = useQuery({ queryKey: [...teamKeys.account(user?.id ?? ''), 'overview-directory', context?.team_id],
    queryFn: context && user ? ({ signal }) => api.directory({ limit: 3 }, signal) : skipToken, enabled: session.status === 'ready' })
  if (!context) return null
  return <div className="gg-team-overview">
    <div className="gg-team-overview-title"><Avatar name={context.team_name} seed={context.team_id} variant="group" size="md" />
      <div><h2>{context.team_name}</h2><span>{teamRoleLabel(context.role, t)}</span></div></div>
    <div className="gg-team-overview-grid">
      <section><div className="gg-team-section-heading"><h2>{t('myUsage')}</h2><Button variant="ghost" onClick={onUsage}>{t('all')}</Button></div>
        <div className="gg-team-my-summary"><small>{t('monthUsed')}</small><strong>{formatCredits(context.used_credits)}</strong>
          <small>{t('monthCap')} {context.cap_credits === null ? t('noCap') : formatCredits(context.cap_credits)}</small></div></section>
      <section><div className="gg-team-section-heading"><h2>{t('directory')}</h2><Button variant="ghost" onClick={onDirectory}>{t('all')}</Button></div>
        {people.isPending || people.isError ? <TeamAsyncState pending={people.isPending} error={people.error} retry={() => { void people.refetch() }} />
          : people.data.members.length ? people.data.members.map(member => <TeamPersonRow key={member.identity_id} member={member} onClick={() => onMember(member)} />)
            : <PaneEmptyState caption={t('noMembers')} />}</section>
    </div>
  </div>
}
