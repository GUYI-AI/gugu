import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/Button'
import { openAgentHomeImport } from './ensure-agent-home'

export function AgentHomeRepair({ providerId, name, machine, onImported }: {
  providerId: string; name?: string; machine: string | null; onImported?: () => void
}) {
  const { t } = useTranslation('main')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const open = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (await openAgentHomeImport(providerId, machine)) onImported?.()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return <div className="flex flex-wrap items-center gap-2">
    <span>{name ? t('agentHome.repairRequired', { name }) : t('agentHome.repairRequiredGeneric')}</span>
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void open()}>{t('agentHome.repairAction')}</Button>
    {failed && <span role="alert">{t('agentHome.repairFailed')}</span>}
  </div>
}
