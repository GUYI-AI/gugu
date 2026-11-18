import type { IOSAgentClient, IOSHostChannel } from './iosAgentClient'
import type { IOSHostOwnerSource } from './iosHostRuntimeStore'
import type { PhoneAgentHostCall, PhoneAgentHostReply } from '../local-agent/nativeAgent'

type Provider = { owner: Pick<IOSHostOwnerSource, 'getSnapshot'>; client: IOSAgentClient }
let provider: Provider | null = null

/** Installed by the App-owned iOS projection, without importing auth into the
 * shared phone RPC entry. It lends no credential or native permission. */
export function installIOSLocalHostRoute(owner: Provider['owner'], client: IOSAgentClient): () => void {
  const installed = { owner, client }
  provider = installed
  return () => { if (provider === installed) provider = null }
}

export function bindIOSLocalHostRoute(ownerId: string, deviceId: string): ((input: PhoneAgentHostCall) => Promise<PhoneAgentHostReply>) | null {
  const current = provider
  if (!current?.client.available()) return null
  const publication = current.owner.getSnapshot()
  if (publication.status !== 'ready' || !publication.binding || publication.binding.ownerId !== ownerId || publication.binding.deviceId !== deviceId) return null
  const binding = { ...publication.binding }
  const requireCurrent = () => {
    const latest = current.owner.getSnapshot()
    if (provider !== current || latest !== publication || latest.status !== 'ready'
      || latest.binding?.ownerId !== binding.ownerId || latest.binding.deviceId !== binding.deviceId
      || latest.binding.installationId !== binding.installationId) {
      throw Object.assign(new Error('本机宿主身份已变化，请保留原请求编号核对结果。'), { code: 'stale_context', admission: 'uncertain' })
    }
  }
  return async input => {
    requireCurrent()
    if (input.ownerId !== binding.ownerId) throw Object.assign(new Error('本机宿主请求账号不匹配。'), { code: 'stale_context', admission: 'rejected' })
    const reply = await current.client.call(binding, input.id, input.channel as IOSHostChannel, input.args)
    requireCurrent()
    return reply
  }
}
