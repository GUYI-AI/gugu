import { i18n } from '@/i18n'
import { dismissNotice, notify } from '@/lib/notices'
import { replica } from '@/lib/replica'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { openShellSettings } from '@renderer/lib/open-shell-settings'

const key = 'gugu.firstInstallImport.v1'
let shown = false

export const firstInstallImportHomes = replica({
  name: 'firstInstallImportHomes',
  scope: 'device',
  read: async (): Promise<AgentHomeScan[]> => {
    const client = await getAgentConfigRuntimeClient()
    const result = await client.scanAgentHomes({ firstInstallOnly: true })
    if (!result.success) throw new Error('Could not detect local configuration for import')
    return result.data
  },
})

export function showFirstInstallImportNotice(homes: readonly AgentHomeScan[]): void {
  if (!homes.length || shown) return
  try { if (localStorage.getItem(key)) return } catch { /* A window can still show and dismiss this notice. */ }
  shown = true
  const handled = () => {
    try { localStorage.setItem(key, '1') } catch { /* The in-memory flag still prevents repeats in this window. */ }
  }
  const t = i18n.getFixedT(null, 'main')
  notify({
    key, title: t('firstInstallImport.title'), description: t('firstInstallImport.description'),
    ongoing: true, presentation: 'first-install-import', onDismiss: handled,
    action: { label: t('settings.dataImport.action'), onClick: () => {
      openShellSettings('data-import')
      handled()
      dismissNotice(key)
    } },
  })
}
