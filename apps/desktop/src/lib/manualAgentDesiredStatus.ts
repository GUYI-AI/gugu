import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { platform } from '../platform'
import { getRendererSession } from './sessionPublication'
import { LocalDeviceUnidentifiedError } from './localDeviceIdentity'

/** Only the two explicit user controls call this. Automatic reconciliation and
 * assistant migration keep using the ordinary contacts operation directly.
 */
export async function commitManualAgentDesiredStatus(
  agent: Pick<ContactUser, 'owner_user_id' | 'device_id' | 'desired_status'>,
  next: 'online' | 'offline', commit: () => Promise<void>,
): Promise<void> {
  const ownerId = getRendererSession()?.user.id
  if (platform.kind !== 'electron' || !platform.accountClosureV2 || next !== 'online'
    || agent.desired_status !== 'offline' || !agent.device_id) {
    await commit()
    return
  }
  if (!ownerId || agent.owner_user_id !== ownerId) {
    throw Object.assign(new Error('Current account changed'), { code: 'wrong_local_owner' })
  }
  const sameOwner = () => {
    if (getRendererSession()?.user.id !== ownerId) {
      throw Object.assign(new Error('Current account changed'), { code: 'wrong_local_owner' })
    }
  }
  sameOwner()
  const local = await platform.getLocalDeviceSelfSnapshot?.()
  sameOwner()
  if (!local) throw new LocalDeviceUnidentifiedError()
  if (local.device_id === agent.device_id) {
    if (!platform.resumeAgentsAfterAccountClosure) {
      throw Object.assign(new Error('Native account closure resume is unavailable'), { code: 'closure_unavailable' })
    }
    await platform.resumeAgentsAfterAccountClosure(ownerId)
    sameOwner()
  }
  await commit()
  sameOwner()
}
