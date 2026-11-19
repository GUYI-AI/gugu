import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'

export function AgentHomePreparationStatus({ preparation }: { preparation: NonNullable<AgentHomeScan['migrationPreparation']> }) {
  const { t } = useTranslation('main')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - preparation.startedAt) / 1000))
  return <span role="status" className="gg-import-meta">{t('agentHome.preparation.elapsedLabel', { label: t(`agentHome.preparation.${preparation.phase}`), count: elapsed })}</span>
}
