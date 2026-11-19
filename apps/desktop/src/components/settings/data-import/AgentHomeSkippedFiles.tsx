import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'

export function AgentHomeSkippedFiles({ issues }: { issues: AgentHomeScan['issues'] }) {
  const { t } = useTranslation('main')
  const [expanded, setExpanded] = useState(false)
  if (!issues.length) return null
  const summary = issues.every(({ reason }) => reason === 'tooLarge') ? 'tooLargeSummary' : 'skippedSummary'
  return <details className="gg-import-meta agent-home-skipped" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{t(`agentHome.issue.${summary}`, { count: issues.length })}</summary>
    {expanded && <ul className="break-all">
      {issues.map(({ path, reason }) => <li key={`${reason}:${path}`}>{path} · {t(`agentHome.issue.${reason}`)}</li>)}
    </ul>}
  </details>
}
