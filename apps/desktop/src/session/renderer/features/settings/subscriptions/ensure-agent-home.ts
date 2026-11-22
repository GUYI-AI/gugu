import { openShellSettings } from '@renderer/lib/open-shell-settings'
import { WireError } from '@gugu/session-wire'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { errorText } from './subscription-queries'
import { showModal } from '@renderer/lib/modal/modal-provider'
import { settingsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store'
import { replica } from '@/lib/replica'

/** Re-import an already migrated configuration from Subscriptions. */
export async function openAgentHomeImport(providerId: string, machine: string | null): Promise<boolean> {
  const home = await readAgentHome(providerId, machine)
  if (!home) return false
  if (home.needsImport) {
    if (home.sourceReadable) openAgentHomeImportPage(machine)
    return false
  }
  const diff = await readAgentHomeDiff(providerId, machine)
  return new Promise((resolve) => showModal('agentHomeReimportModal', {
    providerId, machine, diff, onSuccess: () => resolve(true), onClose: () => resolve(false),
  }))
}

export function openAgentHomeImportPage(machine: string | null) {
  settingsDeviceStore.select(machine ?? 'local')
  openShellSettings('data-import')
}

/** Persistent inventory, including imported homes whose CLI may no longer be installed. */
export const agentConfigImportHomes = replica({
  name: 'agentConfigImportHomes', scope: 'device',
  read: async (_device: string, machine: string | null = null) => {
    const { rpcOn } = await import('@renderer/lib/ipc')
    // This existing lookup contains every registered provider, regardless of installation or
    // availability in the new-task picker. Do not lose an imported home when its CLI is removed.
    const providers = await rpcOn(machine).agents.listIcons()
    const client = await getAgentConfigRuntimeClient(machine)
    const result = await client.scanAgentHomes({ providerIds: Object.keys(providers) })
    if (!result.success) throw new Error(errorText(result.error))
    return result.data.filter(home => home.sourceReadable)
  },
})

export async function readAgentHomeDiff(providerId: string, machine: string | null) {
  const client = await getAgentConfigRuntimeClient(machine)
  const result = await client.diffAgentHome({ providerId })
  if (!result.success) throw new Error(errorText(result.error))
  return result.data
}

export async function readAgentHome(providerId: string, machine: string | null) {
  try {
    const client = await getAgentConfigRuntimeClient(machine)
    const result = await client.scanAgentHomes({ providerIds: [providerId] })
    if (!result.success) throw new Error(errorText(result.error))
    return result.data[0] ?? null
  } catch (error) {
    // Devices running an earlier desktop release still own their session setup.
    if (machine && error instanceof WireError && error.code === 'UNKNOWN_PROCEDURE') return null
    throw error
  }
}

/** A provider's configuration home on a machine (null = this one): the data-import page and the subscriptions row read this one. */
export const agentHome = replica({
  name: 'agentHome',
  scope: 'device',
  read: (_device: string, machine: string | null, providerId: string) => readAgentHome(providerId, machine),
  // While the home is being prepared for a move, it is read every second until it says it is done.
  refreshEvery: (home) => (home?.migrationPreparation ? 1000 : false),
})
