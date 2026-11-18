import { platform } from '@/platform'
import { WireError } from '@gugu/session-wire'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { errorText } from './subscription-queries'
import { showModal } from '@renderer/lib/modal/modal-provider'

/** A person's session-start action waits for the same explicit import card as onboarding. */
export async function ensureAgentHomeImported(providerId: string, machine: string | null): Promise<void> {
  if (platform.kind !== 'electron' && !machine) return
  const home = await readAgentHome(providerId, machine)
  if (!home?.needsImport) return
  if (!home.sourceReadable && !home.migration) {
    const client = await getAgentConfigRuntimeClient(machine)
    const initialized = await client.importAgentHome({ providerId, groups: [] })
    if (!initialized.success) throw new Error(errorText(initialized.error))
    return
  }
  await new Promise<void>((resolve, reject) => showModal('agentHomeImportModal', {
    home, machine, onSuccess: resolve, onClose: () => reject(new Error('Local configuration import was cancelled')),
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
