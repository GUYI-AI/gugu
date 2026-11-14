import { Capacitor, registerPlugin } from '@capacitor/core'

export interface IOSOwnerBinding {
  ownerId: string
  deviceId: string
  installationId: string
}
export interface IOSOwnerClient {
  available(): boolean
  publish(input: { ownerId: string; accessToken: string }): Promise<IOSOwnerBinding>
  getBinding(ownerId: string): Promise<IOSOwnerBinding | null>
  retire(ownerId: string): Promise<void>
}
export class IOSOwnerClientError extends Error {
  constructor(public readonly code: 'unavailable' | 'invalid_native_reply', message: string) {
    super(message)
    this.name = 'IOSOwnerClientError'
  }
}

const nativeOwner = registerPlugin<{
  publishSession(input: { ownerId: string; accessToken: string }): Promise<unknown>
  getBinding(input: { ownerId: string }): Promise<unknown>
  retireSession(input: { ownerId: string }): Promise<unknown>
}>('GuguIOSOwner')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function iosOwnerAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('GuguIOSOwner')
}
function requireNative(ownerId: string): void {
  if (!iosOwnerAvailable()) throw new IOSOwnerClientError('unavailable', '此安装包暂未提供本机身份核验。')
  if (!UUID.test(ownerId)) throw invalidReply()
}
function invalidReply(): IOSOwnerClientError {
  return new IOSOwnerClientError('invalid_native_reply', '未读到有效的本机身份，请重新核验。')
}
function bindingReply(value: unknown, ownerId: string): IOSOwnerBinding | null {
  if (!value || typeof value !== 'object') throw invalidReply()
  const reply = value as Record<string, unknown>
  if (reply.available === false && reply.binding === null) return null
  if (reply.available !== true || !reply.binding || typeof reply.binding !== 'object') throw invalidReply()
  const binding = reply.binding as Record<string, unknown>
  if (binding.ownerId !== ownerId || typeof binding.installationId !== 'string' || !UUID.test(binding.installationId)
    || binding.deviceId !== `phone-${binding.installationId}-${ownerId}`) throw invalidReply()
  return { ownerId, deviceId: binding.deviceId, installationId: binding.installationId }
}

export const iosOwnerClient: IOSOwnerClient = {
  available: iosOwnerAvailable,
  async publish({ ownerId, accessToken }) {
    requireNative(ownerId)
    if (!accessToken || accessToken.trim() !== accessToken) throw invalidReply()
    // Reconstruct the payload; no Session, refresh credential or caller extras cross this boundary.
    const binding = bindingReply(await nativeOwner.publishSession({ ownerId, accessToken }), ownerId)
    if (!binding) throw invalidReply()
    return binding
  },
  async getBinding(ownerId) {
    requireNative(ownerId)
    return bindingReply(await nativeOwner.getBinding({ ownerId }), ownerId)
  },
  async retire(ownerId) {
    requireNative(ownerId)
    const reply = await nativeOwner.retireSession({ ownerId })
    if (!reply || typeof reply !== 'object' || (reply as Record<string, unknown>).retired !== true) throw invalidReply()
  },
}
