import { withAbortSignal, type AbortablePromiseLike } from './boundedOperation'

export interface DeviceRegistrationInput {
  device_id: string
  machine_id: string
  tier: string
  label: string
  hostname: string
  platform: string
  capabilities: Record<string, unknown>
  session_digest?: unknown[]
  reserve_only?: boolean
}

type RegistrationResponse = {
  data?: unknown
  error: { message: string; code?: string; details?: string | null } | null
}

export interface DeviceRegistrationClient {
  rpc(name: 'register_gugu_device', args: { p_device: DeviceRegistrationInput }): AbortablePromiseLike<RegistrationResponse>
}

export class DeviceRegistrationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'DeviceRegistrationError'
  }
}

/** The server derives ownership from auth.uid(); never forward a device row wholesale. */
export async function registerGuguDevice(
  client: DeviceRegistrationClient,
  input: DeviceRegistrationInput,
  options: { signal?: AbortSignal; expectedDeviceId?: string } = {},
): Promise<{ deviceId: string; created: boolean }> {
  const payload: DeviceRegistrationInput = {
    device_id: input.device_id,
    machine_id: input.machine_id,
    tier: input.tier,
    label: input.label,
    hostname: input.hostname,
    platform: input.platform,
    capabilities: input.capabilities,
    ...(input.session_digest !== undefined ? { session_digest: input.session_digest } : {}),
    ...(input.reserve_only !== undefined ? { reserve_only: input.reserve_only } : {}),
  }
  const request = client.rpc('register_gugu_device', { p_device: payload })
  const { data, error } = await (options.signal ? withAbortSignal(request, options.signal) : request)
  if (error) throw new DeviceRegistrationError(error.message, error.code ?? 'DEVICE_REGISTRATION_FAILED')
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !('device_id' in data) || typeof data.device_id !== 'string'
    || !data.device_id.trim() || data.device_id !== data.device_id.trim()
    || !('created' in data) || typeof data.created !== 'boolean') {
    throw new DeviceRegistrationError('Device registration returned no valid canonical identity', 'DEVICE_REGISTRATION_INVALID_RESPONSE')
  }
  if (options.expectedDeviceId !== undefined && data.device_id !== options.expectedDeviceId) {
    throw new DeviceRegistrationError('Device registration differs from the active device binding', 'DEVICE_REGISTRATION_IDENTITY_CHANGED')
  }
  return { deviceId: data.device_id, created: data.created }
}
