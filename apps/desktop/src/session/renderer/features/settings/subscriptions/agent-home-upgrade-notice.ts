import { i18n } from '@/i18n'
import { notify } from '@/lib/notices'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { openShellSettings } from '@renderer/lib/open-shell-settings'

const shown = new Set<string>()

export function showAgentHomeUpgradeNotice(home: AgentHomeScan, machine: string | null): void {
  if (!home.upgraded) return
  const key = `gugu.agentHomeUpgrade:${JSON.stringify([machine, home.providerId, home.importedAt])}`
  if (shown.has(key)) return
  shown.add(key)
  try {
    if (localStorage.getItem(key)) return
    localStorage.setItem(key, '1')
  } catch { /* The in-memory key still prevents duplicate notices in this window. */ }
  const t = i18n.getFixedT(null, 'main')
  const description = [
    home.upgradeSignIn === 'copied' && t('agentHome.upgradeCopied'),
    home.upgradeSignIn === 'relogin' && t('agentHome.upgradeRelogin', { name: home.name }),
    home.terminalNeedsSignIn && t('agentHome.terminalSignIn', { name: home.name }),
    !!home.oldSessionsSkipped && t('agentHome.oldSessionsSkipped', { count: home.oldSessionsSkipped }),
  ].filter(Boolean).join(' ')
  notify({
    key, title: t('agentHome.upgradeKept', { name: home.name }), description,
    tier: home.upgradeSignIn === 'relogin' ? 'warning' : 'info',
    duration: 12000,
    action: { label: t(home.upgradeSignIn === 'relogin' ? 'agentHome.signInAction' : 'agentHome.reimport'),
      onClick: () => openShellSettings('subscriptions') },
  })
}
