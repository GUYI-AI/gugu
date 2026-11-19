import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { replica, useReplica } from '@/lib/replica'
import { readAgentHomeUpgradeResults } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { AgentHomePreparationStatus } from './AgentHomePreparationStatus'
import { AgentHomeSkippedFiles } from './AgentHomeSkippedFiles'
import { DataImportSection } from './DataImportSection'
import { useExternalImportProviders } from './use-external-import-providers'

const agentHomeUpgradeResults = replica({
  name: 'agentHomeUpgradeResults',
  scope: 'device',
  read: readAgentHomeUpgradeResults,
})

export function DesktopDataImportSection({ onClose }: { onClose: () => void }) {
  const { providers, historyDialog } = useExternalImportProviders()
  return (
    <>
      <DataImportSection onClose={onClose} extraProviders={providers} localDetails={<AgentHomeMigrationResults />} />
      {historyDialog}
    </>
  )
}

export function AgentHomeMigrationResults() {
  const { t } = useTranslation('main')
  const reading = useReplica(agentHomeUpgradeResults, [])
  const preparing = reading.state === 'value' && reading.value.some((home) => home.migrationPreparation)
  useEffect(() => {
    if (!preparing) return
    const timer = setInterval(() => {
      // The replica publishes read errors to the existing error UI.
      void agentHomeUpgradeResults.refresh().catch(() => {})
    }, 1000)
    return () => clearInterval(timer)
  }, [preparing])
  if (reading.state === 'error') return <p role="status" className="gg-import-meta">{t('agentHome.migrationReadFailed')}</p>
  if (reading.state !== 'value') return null
  const skipped = reading.value.filter((home) => home.migrationPreparation || home.historyImport || home.migrationSpace || (home.upgradeIssues?.length ?? home.oldSessionsSkipped ?? 0) > 0)
  if (!skipped.length) return null
  return <section className="gg-import-history">
    <h3>{t('agentHome.migrationResults')}</h3>
    <div className="gg-import-history-list">
      {skipped.map((home) => <div key={home.providerId} className="gg-import-history-entry p-3">
        <div className="gg-import-name">{home.name}</div>
        {home.migrationPreparation && <AgentHomePreparationStatus preparation={home.migrationPreparation} />}
        {home.historyImport && <p className="gg-import-meta">{t('agentHome.historySummary', { count: home.historyImport.imported, skipped: home.historyImport.skipped })}</p>}
        {home.migrationSpace ? <p className="gg-import-meta">{t('agentHome.migrationSpaceNotice', { size: Math.ceil(home.migrationSpace.shortfallBytes / 100_000_000) / 10 })}</p> : home.upgradeIssues?.length ? <AgentHomeSkippedFiles issues={home.upgradeIssues} />
          : home.oldSessionsSkipped ? <p className="gg-import-meta">{t('agentHome.oldSessionsSkipped', { count: home.oldSessionsSkipped })}</p> : null}
      </div>)}
    </div>
  </section>
}
