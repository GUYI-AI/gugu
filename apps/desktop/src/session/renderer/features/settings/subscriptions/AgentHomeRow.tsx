import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AgentHomePreparationStatus } from '@/components/settings/data-import/AgentHomePreparationStatus'
import { Button } from '@/components/ui/Button'
import { SettingsRow } from '@/components/settings/SettingsPrimitives'
import { messageForUser } from '@/lib/userFacingError'
import { refreshFailure, useReplica } from '@/lib/replica'
import { agentHome, openAgentHomeImport } from './ensure-agent-home'

export function AgentHomeRow({ providerId, machine, disabled = false }: { providerId: string; machine: string | null; disabled?: boolean }) {
  const { t, i18n } = useTranslation('main')
  const reading = useReplica(agentHome, [machine, providerId], { read: !disabled })
  const home = reading.state === 'value' ? reading.value : undefined
  const readError = refreshFailure(reading)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const error = actionError ?? (readError && messageForUser(readError))
  const open = async () => {
    setBusy(true)
    setActionError(null)
    try {
      if (await openAgentHomeImport(providerId, machine)) await agentHome.refresh(machine, providerId)
    } catch (error) { setActionError(messageForUser(error)) }
    finally { setBusy(false) }
  }
  if (!home && !error) return null
  return <SettingsRow title={t('agentHome.local')}
      description={<>{home?.migrationPreparation ? <AgentHomePreparationStatus preparation={home.migrationPreparation} /> : home?.importedAt ? <>
        {t('agentHome.row', { date: new Intl.DateTimeFormat(i18n.language, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(home.importedAt)) })}
        {home.sourceUpdated && t('agentHome.updated')}
      </> : home?.sourceReadable ? t('firstInstallImport.available', { name: home.name }) : t('agentHome.sourceUnavailable')}
        {error && <span role="alert" className="block text-destructive">{error}</span>}</>}
      control={home?.needsImport && !home.sourceReadable ? undefined : <Button variant="secondary" size="sm" onClick={() => void open()} disabled={disabled || busy || !home || Boolean(home.migrationPreparation)} data-testid={`agent-home-reimport-${providerId}`}>{t(home?.needsImport ? 'settings.dataImport.action' : 'agentHome.reimport')}</Button>} />
}
