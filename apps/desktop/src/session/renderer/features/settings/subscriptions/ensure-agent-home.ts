import { platform } from '@/platform'
import type { AgentHomeScan } from '@gugu/session-core/workspace-server/agent-config'
import { WireError } from '@gugu/session-wire'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { showAgentHomeUpgradeNotice } from './agent-home-upgrade-notice'
import { errorText } from './subscription-queries'
import { showModal } from '@renderer/lib/modal/modal-provider'

/** A person's session-start action waits for the same explicit import card as onboarding. */
export async function ensureAgentHomeImported(providerId: string, machine: string | null): Promise<void> {
  if (platform.kind !== 'electron' && !machine) return
  const home = await readAgentHome(providerId, machine)
  if (!home) return
  showAgentHomeUpgradeNotice(home, machine)
  if (!home.needsImport) return
  if (!machine && !home.sourceReadable && !home.migration) {
    const client = await getAgentConfigRuntimeClient(machine)
    const initialized = await client.importAgentHome({ providerId, groups: [] })
    if (!initialized.success) throw new Error(errorText(initialized.error))
    return
  }
  if (!await chooseAgentHomeImport(home, machine)) throw new Error('Local configuration import was cancelled')
}

/** Subscriptions and the startup repair action open the same choice on the same host. */
export async function openAgentHomeImport(providerId: string, machine: string | null): Promise<boolean> {
  const home = await readAgentHome(providerId, machine)
  if (!home) return false
  if (home.needsImport) return chooseAgentHomeImport(home, machine)
  const client = await getAgentConfigRuntimeClient(machine)
  const result = await client.diffAgentHome({ providerId })
  if (!result.success) throw new Error(errorText(result.error))
  return new Promise((resolve) => showModal('agentHomeReimportModal', {
    providerId, machine, diff: result.data, onSuccess: () => resolve(true), onClose: () => resolve(false),
  }))
}

function chooseAgentHomeImport(home: AgentHomeScan, machine: string | null): Promise<boolean> {
  return new Promise((resolve) => showModal('agentHomeImportModal', {
    home, machine, onSuccess: () => resolve(true), onClose: () => resolve(false),
  }))
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
