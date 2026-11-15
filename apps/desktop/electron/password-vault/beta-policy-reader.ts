import type { VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings'
import { ServicePermissionPolicyStore } from '../permissions/policy-store'
import { makeIdentityClient } from '../supabase'

/** Account-authenticated identity schema, matching the existing permission runtime. No public-schema fallback. */
export function createPasswordBetaPolicyReader(getAuth: () => Promise<{ userId: string; accessToken: string } | null>) {
  return async (ownerId: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    const auth = await getAuth()
    if (!auth || auth.userId !== ownerId) throw new Error('password_policy_unavailable')
    const client = makeIdentityClient(auth.accessToken)
    const store = new ServicePermissionPolicyStore(client as unknown as VersionedSettingsTableClient)
    const result = await store.read(ownerId, signal)
    signal.throwIfAborted()
    if ((await getAuth())?.userId !== ownerId) throw new Error('password_policy_unavailable')
    return result
  }
}
