import { registerPlugin } from '@capacitor/core'
import type { AccountClosureNative, AccountClosureResult, AccountClosureScope } from './accountClosure'

interface NativeClosure {
  put(input: AccountClosureScope & { receipt: string }): Promise<void>
  get(input: AccountClosureScope): Promise<{ value: string | null }>
  remove(input: AccountClosureScope): Promise<void>
  eraseLocal(input: AccountClosureScope): Promise<AccountClosureResult>
}

/** No receipt interpolation, logging, URL transport or plaintext fallback. */
export function iosAccountClosure(native: NativeClosure): AccountClosureNative {
  return {
    receipt: {
      put: (scope, receipt) => native.put({ ...scope, receipt }),
      async get(scope) {
        const reply = await native.get(scope)
        if (reply.value !== null && typeof reply.value !== 'string') throw new Error('Invalid native closure storage reply')
        return reply.value
      },
      remove: (scope) => native.remove(scope),
    },
    async eraseLocal(scope) {
      const reply = await native.eraseLocal(scope)
      if (!['complete', 'pending'].includes(reply.status) || !Array.isArray(reply.retainedUnattributed)
        || reply.retainedUnattributed.some((name) => typeof name !== 'string')) throw new Error('Invalid native closure cleanup reply')
      return reply
    },
  }
}
export const nativeIOSAccountClosure = iosAccountClosure(registerPlugin<NativeClosure>('GuguAccountClosure'))
