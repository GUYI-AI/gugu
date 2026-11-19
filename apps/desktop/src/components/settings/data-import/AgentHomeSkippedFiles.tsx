import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'

type Issues = AgentHomeScan['issues']
function IssueGroup({ name, issues }: { name: string; issues: Issues }) {
  const { t } = useTranslation('main')
  const [expanded, setExpanded] = useState(false)
  const summary = issues.every(({ reason }) => reason === 'symlink') ? 'groupLinksSummary'
    : issues.every(({ reason }) => reason === 'historyLimit') ? 'groupHistoryLimitSummary'
    : issues.every(({ reason }) => reason === 'tooLarge') ? 'groupTooLargeSummary' : 'groupSkippedSummary'
  return <details className="gg-import-meta agent-home-skipped" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>{t(`agentHome.issue.${summary}`, { name, count: issues.length })}</summary>
    {expanded && <ul className="break-all">
      {issues.map(({ path, reason }) => <li key={`${reason}:${path}`}>{path}: {t(`agentHome.issue.${reason}`)}</li>)}
    </ul>}
  </details>
}
export function AgentHomeSkippedFiles({ issues }: { issues: Issues }) {
  const { t } = useTranslation('main')
  const groups = new Map<string, { name: string; issues: Issues }>()
  for (const issue of issues) {
    const parts = issue.path.replaceAll('\\', '/').split('/')
    const key = parts[0] === 'skills' && parts[1] ? 'skills/' + parts[1] : parts[0] || issue.path
    const name = key.startsWith('skills/') ? parts[1]! : ['rules', 'agents', 'models'].includes(key)
      ? t(`agentHome.groups.${key}`) : key
    const group = groups.get(key) ?? { name, issues: [] }
    if (!group.issues.some((item) => item.path === issue.path && item.reason === issue.reason)) group.issues.push(issue)
    groups.set(key, group)
  }
  return <>{[...groups].map(([key, group]) => <IssueGroup key={key} {...group} />)}</>
}
