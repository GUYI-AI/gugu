import type { Device } from '@gugu/core/shared/types/chat'
import { machineLibraryHost } from '@renderer/features/library/library-host'
import { phoneLibraryTransport } from '../agent-watch/sessionpage-rpc'

export function marketDeviceHost(device: Device) {
  return machineLibraryHost({
    deviceId: device.device_id,
    deviceLabel: device.label || device.hostname,
    online: device.is_online,
    lastSeenAt: device.last_seen_at,
    hostKind: device.capabilities.host_kind === 'server' ? 'server' : 'desktop',
  }, phoneLibraryTransport(device.device_id))
}
