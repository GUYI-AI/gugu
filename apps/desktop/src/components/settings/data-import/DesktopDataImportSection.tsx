import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useReplica } from '@/lib/replica'
import { agentHomeUpgradeResults } from '@renderer/features/settings/subscriptions/agent-home-upgrade-notice'
import { AgentHomeMigrationResultList } from './AgentHomeMigrationResultList'
import { DataImportSection } from './DataImportSection'
import { AgentConfigImport } from './AgentConfigImport'
import { agentConfigImportHomes } from '@renderer/features/settings/subscriptions/ensure-agent-home'
import { useExternalImportProviders } from './use-external-import-providers'

export function DesktopDataImportSection({ onClose }: { onClose: () => void }) {
  const { providers, historyDialog } = useExternalImportProviders()
  return (
    <>
      <DataImportSection onClose={onClose} extraProviders={providers} localDetails={<><TerminalConfigImports machine={null} /><AgentHomeMigrationResults /></>} machineDetails={(machine) => <TerminalConfigImports key={machine} machine={machine} />} />
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

export function TerminalConfigImports({ machine }: { machine: string | null }) {
  const { t } = useTranslation('main')
  const reading = useReplica(agentConfigImportHomes, [machine])
  if (reading.state === 'error') return <p role="status" className="gg-import-meta">{t('agentHome.migrationReadFailed')}</p>
  if (reading.state !== 'value') return null
  return reading.value.map(({ providerId }) =>
    <AgentConfigImport key={`${machine ?? 'local'}:${providerId}`} providerId={providerId} machine={machine} />)
}
