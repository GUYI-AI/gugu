import { useDeferredValue, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SearchField } from '@/components/ui/SearchField'
import { PaneEmptyState } from '@/components/ui/PaneEmptyState'
import { useTeamSession } from './context'
import { TeamOverview } from './TeamOverview'
import { TeamDirectory } from './TeamDirectory'
import { TeamUsage, TeamPauseState } from './TeamUsage'
import { TeamMembers } from './TeamMembers'
import { TeamCredits } from './TeamCredits'
import { isTeamSection, TEAM_NAVIGATION_EVENT, type TeamSection } from './navigation'
import type { TeamDirectoryMember, TeamStopReason } from './types'
import './team.css'

export function TeamPage({ initialSection = 'overview', onMessage, onTopUp }: {
  initialSection?: TeamSection; onMessage: (member: TeamDirectoryMember) => void; onTopUp: () => void
}) {
  const { t } = useTranslation('team'), session = useTeamSession()
  const [requestedSection, setSection] = useState(initialSection), [query, setQuery] = useState(''), [pause, setPause] = useState<TeamStopReason | null>(null)
  const deferredQuery = useDeferredValue(query.trim()), admin = session.context?.role === 'admin' || session.context?.role === 'superadmin'
  const section = !admin && (requestedSection === 'members' || requestedSection === 'credits') ? 'overview' : requestedSection
  useEffect(() => {
    const navigate = (event: Event) => {
      const next = (event as CustomEvent<{ section?: unknown }>).detail?.section
      if (isTeamSection(next)) { setSection(next); setPause(null) }
    }
    window.addEventListener(TEAM_NAVIGATION_EVENT, navigate)
    return () => window.removeEventListener(TEAM_NAVIGATION_EVENT, navigate)
  }, [])
  if (session.status !== 'ready') return null
  const nav = (value: TeamSection, label: string) => <Button key={value} variant="ghost" aria-current={section === value ? 'page' : undefined}
    className="gg-team-nav-item" onClick={() => { setSection(value); setPause(null) }}>{label}</Button>
  const sectionTitle = t(section === 'usage' ? 'myUsage' : section)
  return <div className="gg-team-page" data-testid="team-page">
    <nav className="gg-team-nav" aria-label={t('title')}><h1>{t('title')}</h1>
      {nav('overview', t('overview'))}{nav('directory', t('directory'))}{nav('usage', t('myUsage'))}{nav('search', t('search'))}
      {admin && <><p>{t('management')}</p>{nav('members', t('members'))}{nav('credits', t('credits'))}</>}
    </nav>
    <main className="gg-team-content"><header className="gg-team-page-heading"><h1>{sectionTitle}</h1></header>
      {pause ? <TeamPauseState reason={pause} onUsage={() => { setSection('usage'); setPause(null) }}
        onContact={() => { setSection('directory'); setPause(null) }} onTopUp={admin ? onTopUp : undefined} /> : <>
        {section === 'overview' && <TeamOverview onUsage={() => setSection('usage')} onDirectory={() => setSection('directory')} onMember={onMessage} />}
        {section === 'directory' && <TeamDirectory onMessage={onMessage} />}
        {section === 'usage' && <TeamUsage onPause={setPause} />}
        {section === 'search' && <><SearchField placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
          {deferredQuery ? <TeamDirectory query={deferredQuery} onMessage={onMessage} /> : <div className="gg-team-state"><PaneEmptyState caption={t('searchHint')} /></div>}</>}
        {section === 'members' && <TeamMembers />}{section === 'credits' && <TeamCredits onTopUp={onTopUp} />}
      </>}
    </main>
  </div>
}
