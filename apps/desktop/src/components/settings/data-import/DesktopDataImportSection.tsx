import { useTranslation } from 'react-i18next'
import { replica, useReplica } from '@/lib/replica'
import { readAgentHomeUpgradeResults } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
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

function AgentHomeMigrationResults() {
  const { t } = useTranslation('main')
  const reading = useReplica(agentHomeUpgradeResults, [])
  if (reading.state === 'error') return <p role="status" className="gg-import-meta">{t('agentHome.migrationReadFailed')}</p>
  if (reading.state !== 'value') return null
  const skipped = reading.value.filter((home) => (home.upgradeIssues?.length ?? home.oldSessionsSkipped ?? 0) > 0)
  if (!skipped.length) return null
  return <section className="gg-import-history">
    <h3>{t('agentHome.migrationResults')}</h3>
    <div className="gg-import-history-list">
      {skipped.map((home) => <div key={home.providerId} className="gg-import-history-entry p-3">
        <div className="gg-import-name">{home.name}</div>
        {home.upgradeIssues ? <AgentHomeSkippedFiles issues={home.upgradeIssues} />
          : <p className="gg-import-meta">{t('agentHome.oldSessionsSkipped', { count: home.oldSessionsSkipped })}</p>}
      </div>)}
    </div>
  </section>
}
