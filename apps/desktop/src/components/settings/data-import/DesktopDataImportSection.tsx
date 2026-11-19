import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { readAgentHomeUpgradeResults } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { AgentHomeSkippedFiles } from './AgentHomeSkippedFiles'
import { DataImportSection } from './DataImportSection'
import { useExternalImportProviders } from './use-external-import-providers'

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
  const [homes, setHomes] = useState<AgentHomeScan[]>([])
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void readAgentHomeUpgradeResults().then((result) => { if (active) setHomes(result) }, () => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  const skipped = homes.filter((home) => (home.upgradeIssues?.length ?? home.oldSessionsSkipped ?? 0) > 0)
  if (failed) return <p role="status" className="gg-import-meta">{t('agentHome.migrationReadFailed')}</p>
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
