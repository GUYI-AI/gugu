import { WireError } from '@gugu/session-wire'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { errorText } from './subscription-queries'
import { showModal } from '@renderer/lib/modal/modal-provider'

/** Re-import an already migrated configuration from Subscriptions. */
export async function openAgentHomeImport(providerId: string, machine: string | null): Promise<boolean> {
  const home = await readAgentHome(providerId, machine)
  if (!home || home.needsImport) return false
  const client = await getAgentConfigRuntimeClient(machine)
  const result = await client.diffAgentHome({ providerId })
  if (!result.success) throw new Error(errorText(result.error))
  return new Promise((resolve) => showModal('agentHomeReimportModal', {
    providerId, machine, diff: result.data, onSuccess: () => resolve(true), onClose: () => resolve(false),
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
