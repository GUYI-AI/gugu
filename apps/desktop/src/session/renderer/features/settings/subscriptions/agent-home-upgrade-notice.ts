import { i18n } from '@/i18n'
import { notify } from '@/lib/notices'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { openShellSettings } from '@renderer/lib/open-shell-settings'

const shown = new Set<string>()

export async function readAgentHomeUpgradeResults(): Promise<AgentHomeScan[]> {
  const client = await getAgentConfigRuntimeClient()
  const result = await client.scanAgentHomes({ providerIds: ['codex', 'claude'] })
  if (!result.success) throw new Error('Could not read configuration migration results')
  return result.data.filter(({ upgraded }) => upgraded)
}

export function showAgentHomeUpgradeNotice(homes: readonly AgentHomeScan[]): void {
  if (!homes.length) return
  const key = `gugu.agentHomeMigration:${JSON.stringify(homes.map(({ providerId, importedAt }) => [providerId, importedAt]))}`
  if (shown.has(key)) return
  shown.add(key)
  try {
    if (localStorage.getItem(key)) return
    localStorage.setItem(key, '1')
  } catch { /* The in-memory key still prevents duplicate notices in this window. */ }
  const t = i18n.getFixedT(null, 'main')
  const names = new Intl.ListFormat(i18n.language).format(homes.map(({ name }) => name))
  const skipped = homes.reduce((total, home) => total + (home.upgradeIssues?.length ?? home.oldSessionsSkipped ?? 0), 0)
  const copied = !skipped && homes.every(({ upgradeSignIn }) => upgradeSignIn === 'copied')
  notify({
    key, title: t('agentHome.migrationNoticeTitle'), tier: 'info', duration: 12000,
    description: t(copied ? 'agentHome.migrationNoticeCopied' : 'agentHome.migrationNotice', { names }),
    ...(skipped > 0 ? {
      action: { label: t('agentHome.migrationSkipped', { count: skipped }), onClick: () => openShellSettings('data-import') },
    } : {}),
  })
}
