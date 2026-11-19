import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { AgentHomePreparationStatus } from './AgentHomePreparationStatus'
import { AgentHomeSkippedFiles } from './AgentHomeSkippedFiles'
import './data-import.css'

export function AgentHomeMigrationResultList({ homes }: { homes: readonly AgentHomeScan[] }) {
  const { t } = useTranslation('main')
  const results = homes.filter((home) => home.migrationPreparation || home.historyImport || home.migrationSpace
    || home.upgradeSignIn === 'relogin' || (home.upgradeIssues?.length ?? home.oldSessionsSkipped ?? 0) > 0)
  if (!results.length) return null
  return <section className="gg-import-history">
    <h3>{t('agentHome.migrationResults')}</h3>
    <div className="gg-import-history-list">
      {results.map((home) => <div key={home.providerId} className="gg-import-history-entry p-3">
        <div className="gg-import-name">{home.name}</div>
        {home.migrationPreparation && <AgentHomePreparationStatus preparation={home.migrationPreparation} />}
        {home.historyImport && <p className="gg-import-meta">{t('agentHome.historySummary', { count: home.historyImport.imported, skipped: home.historyImport.skipped })}</p>}
        {home.migrationSpace ? <p className="gg-import-meta">{t('agentHome.migrationSpaceNotice', { size: Math.ceil(home.migrationSpace.shortfallBytes / 100_000_000) / 10 })}</p> : home.upgradeIssues?.length ? <AgentHomeSkippedFiles issues={home.upgradeIssues} />
          : home.oldSessionsSkipped ? <p className="gg-import-meta">{t('agentHome.oldSessionsSkipped', { count: home.oldSessionsSkipped })}</p> : null}
        {home.upgradeSignIn === 'relogin' && <p className="gg-import-meta">{t('agentHome.migrationRelogin', { name: home.name })}</p>}
      </div>)}
    </div>
  </section>
}
