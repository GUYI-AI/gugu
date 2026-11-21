import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'
import { useMyAssistant } from '@/lib/myAssistant'
import { machineRpc } from '../../components/session-watch/sessionpage-rpc'
import { thisPhoneDeviceId } from './phoneDeviceSettings'

/** Report committed phone choices through the same assistant App channel in settings and setup. */
export function usePhonePermissionReporter(ownerId: string | null) {
  const assistant = useMyAssistant()
  return (action: string, enabled: boolean, group?: string) => {
    // Read and there is none: nothing to tell. Not read yet / unreadable: the notice is queued for the assistant the panel finds.
    if (!ownerId || (assistant.state === 'value' && !assistant.value.agentId)) return
    const known = assistant.state === 'value' ? assistant.value : null
    const deviceId = thisPhoneDeviceId(ownerId) ?? undefined
    void reportAssistantAppChange(known?.provisionDeviceId ? { rpc: machineRpc(known.provisionDeviceId) } : null,
      known?.agentId ?? undefined, { resource: 'devices', operation: 'edited', section: 'permissions',
        id: deviceId ?? 'phone-permission-settings', deviceId, after: { action, enabled, ...(group ? { group } : {}) } }, ownerId)
  }
}
