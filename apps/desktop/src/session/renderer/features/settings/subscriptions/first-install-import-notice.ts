import { i18n } from '@/i18n'
import { dismissNotice, notify } from '@/lib/notices'
import { replica } from '@/lib/replica'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { agentConfigImportHomes, openAgentHomeImportPage } from './ensure-agent-home'
import { machineLabel, machineLinkState, onEachMachine, subscribeMachineLink } from '@renderer/lib/machine-clients'
import { rendererLogger } from '@/lib/log'

const key = 'gugu.firstInstallImport.v1'
const shown = new Set<string>()
const log = rendererLogger('settings/first-install-import')

export const firstInstallImportHomes = replica({
  name: 'firstInstallImportHomes',
  scope: 'device',
  read: async (_device: string, machine: string | null = null): Promise<AgentHomeScan[]> => {
    if (machine) return (await agentConfigImportHomes.fetch(machine)).filter(home => home.needsImport && !home.migration && !home.migrationPreparation && home.groups.some(group => group.count > 0))
    const client = await getAgentConfigRuntimeClient()
    const result = await client.scanAgentHomes({ firstInstallOnly: true })
    if (!result.success) throw new Error('Could not detect local configuration for import')
    return result.data
  },
})

export function showFirstInstallImportNotice(homes: readonly AgentHomeScan[], machine: string | null = null, accountId?: string): void {
  const noticeKey = accountId ? `${key}:${encodeURIComponent(accountId)}:${encodeURIComponent(machine ?? 'local')}` : machine ? `${key}:${encodeURIComponent(machine)}` : key
  if (!homes.length || shown.has(noticeKey)) return
  try { if (localStorage.getItem(noticeKey) || (!machine && localStorage.getItem(key))) return } catch { /* A window can still show and dismiss this notice. */ }
  shown.add(noticeKey)
  const handled = () => {
    try { localStorage.setItem(noticeKey, '1') } catch { /* The in-memory flag still prevents repeats in this window. */ }
  }
  const t = i18n.getFixedT(null, 'main')
  notify({
    key: noticeKey, title: t('firstInstallImport.title'), description: machine ? t('firstInstallImport.remoteDescription', { machine: machineLabel(machine) }) : t('firstInstallImport.description'),
    ongoing: true, presentation: 'first-install-import', onDismiss: handled,
    action: { label: t('settings.dataImport.action'), onClick: () => {
      openAgentHomeImportPage(machine)
      handled()
      dismissNotice(noticeKey)
    } },
  })
}

/** Reuse the same notice on connected machines; no new notice entry point or automatic import. */
export function watchFirstInstallImportNotices(accountId: string): () => void {
  let active = true
  const read = (machine: string | null) => {
    void firstInstallImportHomes.fetch(machine).then(homes => {
      if (active) showFirstInstallImportNotice(homes, machine, accountId)
    }).catch((error: unknown) => log.error({ error: String(error), machine }, 'read configuration import suggestions failed'))
  }
  read(null)
  const stop = onEachMachine(machine => {
    const check = () => { if (machineLinkState(machine) === 'open') read(machine) }
    check()
    return subscribeMachineLink(machine, check)
  })
  return () => { active = false; stop() }
}
