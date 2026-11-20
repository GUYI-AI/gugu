import { registerPlugin } from '@capacitor/core'
import type { AccountClosureNative, AccountClosureResult, AccountClosureScope } from './accountClosure'

interface AndroidClosureBridge {
  put(input: AccountClosureScope & { receipt: string }): Promise<void>
  get(input: AccountClosureScope): Promise<{ value: string | null }>
  remove(input: AccountClosureScope): Promise<void>
  eraseLocal(input: AccountClosureScope): Promise<AccountClosureResult>
  prepareSignOut(input: { ownerId: string }): Promise<unknown>
  retireDevice(input: { ownerId: string; deviceId: string }): Promise<unknown>
  cancelPreparation(input: AccountClosureScope): Promise<unknown>
}
export interface AndroidClosurePreparation {
  prepare(ownerId: string): Promise<{ deviceId: string }>
  retire(ownerId: string, deviceId: string): Promise<void>
  cancel(scope: AccountClosureScope): Promise<void>
}
const invalid = () => Object.assign(new Error('Invalid Android account-closure acknowledgement'), { code: 'closure_storage_unavailable' })
const fields = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object') throw invalid()
  return value as Record<string, unknown>
}
const retainedNames = new Set(['auth-code-verifier', 'auth-oauth-pending', 'shared-incoming-file-cache', 'shared-outgoing-file-cache', 'shared-runtime-temp-cache'])

/** Only the transport envelope is platform-specific; the v0 contract is imported. */
export function androidAccountClosure(native: AndroidClosureBridge): AccountClosureNative {
  return {
    receipt: {
      put: (scope, receipt) => native.put({ ...scope, receipt }),
      async get(scope) {
        const reply = fields(await native.get(scope))
        if (reply.value !== null && typeof reply.value !== 'string') throw invalid()
        return reply.value
      },
      remove: scope => native.remove(scope),
    },
    async eraseLocal(scope) {
      const reply = fields(await native.eraseLocal(scope))
      if ((reply.status !== 'complete' && reply.status !== 'pending') || !Array.isArray(reply.retainedUnattributed)
        || !reply.retainedUnattributed.every(name => typeof name === 'string' && retainedNames.has(name))) throw invalid()
      return { status: reply.status, retainedUnattributed: [...reply.retainedUnattributed] }
    },
  }
}
export function androidClosurePreparation(native: AndroidClosureBridge): AndroidClosurePreparation {
  return {
    async prepare(ownerId) {
      const reply = fields(await native.prepareSignOut({ ownerId }))
      if (reply.prepared !== true || typeof reply.deviceId !== 'string' || !reply.deviceId.startsWith('phone-') || !reply.deviceId.endsWith(`-${ownerId}`)) throw invalid()
      return { deviceId: reply.deviceId }
    },
    async retire(ownerId, deviceId) {
      const { prepareAndroidPushSignOut } = await import('../mobile/android-push/startAndroidPush')
      await prepareAndroidPushSignOut(ownerId)
      if (fields(await native.retireDevice({ ownerId, deviceId })).retired !== true) throw invalid()
    },
    async cancel(scope) {
      if (fields(await native.cancelPreparation(scope)).cancelled !== true) throw invalid()
    },
  }
}
const bridge = registerPlugin<AndroidClosureBridge>('GuguAccountClosure')
export const nativeAndroidAccountClosure = androidAccountClosure(bridge)
export const nativeAndroidClosurePreparation = androidClosurePreparation(bridge)
