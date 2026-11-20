import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { AgentHomePreparationStatus } from './AgentHomePreparationStatus'
import { AgentHomeSkippedFiles } from './AgentHomeSkippedFiles'
import { SettingsGroup, SettingsRow } from '../SettingsPrimitives'
import './data-import.css'

export function AgentHomeMigrationResultList({ homes }: { homes: readonly AgentHomeScan[] }) {
  const { t } = useTranslation('main')
  const results = homes.filter((home) => home.migrationPreparation || home.nativeHistory || home.historyImport || home.migrationSpace
    || home.upgradeSignIn === 'relogin' || (home.upgradeIssues?.length ?? home.oldSessionsSkipped ?? 0) > 0)
  if (!results.length) return null
  return <SettingsGroup title={t('agentHome.migrationResults')}>
    {results.map((home) => <SettingsRow key={home.providerId} title={home.name} description={<>
      {home.migrationPreparation && <AgentHomePreparationStatus preparation={home.migrationPreparation} />}
      {home.nativeHistory && <span>{t('agentHome.nativeHistorySummary', home.nativeHistory)}</span>}
      {home.historyImport && <span>{t('agentHome.historySummary', { count: home.historyImport.imported, skipped: home.historyImport.skipped })}</span>}
      {home.migrationSpace ? <span>{t('agentHome.migrationSpaceNotice', { size: Math.ceil(home.migrationSpace.shortfallBytes / 100_000_000) / 10 })}</span> : home.upgradeIssues?.length ? <AgentHomeSkippedFiles issues={home.upgradeIssues} />
        : home.oldSessionsSkipped ? <span>{t('agentHome.oldSessionsSkipped', { count: home.oldSessionsSkipped })}</span> : null}
      {home.upgradeSignIn === 'relogin' && <span>{t('agentHome.migrationRelogin', { name: home.name })}</span>}
    </>} />)}
  </SettingsGroup>
}
