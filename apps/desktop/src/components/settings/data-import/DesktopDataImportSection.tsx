import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { replica, useReplica } from '@/lib/replica'
import { readAgentHomeUpgradeResults } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { AgentHomeMigrationResultList } from './AgentHomeMigrationResultList'
import { DataImportSection } from './DataImportSection'
import { QwenConfigImport } from './QwenConfigImport'
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
      <DataImportSection onClose={onClose} extraProviders={providers} localDetails={<><QwenConfigImport /><AgentHomeMigrationResults /></>} />
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
  return <AgentHomeMigrationResultList homes={reading.value} />
}
