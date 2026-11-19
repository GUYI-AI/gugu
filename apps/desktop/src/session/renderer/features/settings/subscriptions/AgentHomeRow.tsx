import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { SettingsRow } from '@/components/settings/SettingsPrimitives'
import { messageForUser } from '@/lib/userFacingError'
import { replica, useReplica } from '@/lib/replica'
import { openAgentHomeImport, readAgentHome } from './ensure-agent-home'
import { queryView } from './subscription-queries'

const agentHome = replica({
  name: 'agentHome',
  scope: 'device',
  fresh: 0,
  read: (_device: string, machine: string | null, providerId: string) => readAgentHome(providerId, machine),
})

export function AgentHomeRow({ providerId, machine }: { providerId: string; machine: string | null }) {
  const { t, i18n } = useTranslation('main')
  const { data: home, error: readError } = queryView(useReplica(agentHome, [machine, providerId]))
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
  return <SettingsRow title={<>{t('agentHome.local')}{home?.sourceUpdated && <span className="ml-2 text-xs text-foreground-muted">● {t('agentHome.updated')}</span>}</>}
      description={<>{home?.importedAt ? t('agentHome.row', { date: new Date(home.importedAt).toLocaleString(i18n.language), path: home.userRoot }) : t('agentHome.upgradeRelogin', { name: home?.name ?? providerId })}
        {home?.upgraded && <span className="block">{t('agentHome.upgradeKept', { name: home.name })}</span>}
        {error && <span role="alert" className="block text-destructive">{error}</span>}</>}
      control={home?.needsImport ? undefined : <Button variant="secondary" size="sm" onClick={() => void open()} disabled={busy || !home} data-testid={`agent-home-reimport-${providerId}`}>{t('agentHome.reimport')}</Button>} />
}
