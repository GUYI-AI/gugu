import type { AccountClosureNative } from '@/platform/accountClosure'
import type { AndroidClosurePreparation } from '@/platform/androidAccountClosure'
import { composePhoneAccountClosure, type AccountClosureRequestActions } from '@/components/settings/accountDeletion/accountClosureComposition'
import type { AccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureLocalCleanup'
import type { PhoneCloseAcknowledgement } from '@/components/settings/accountDeletion/phoneAccountClosureFlow'

export interface AndroidClosureDependencies {
  native: AccountClosureNative
  preparation: AndroidClosurePreparation
  currentOwnerId: () => string | null
  stopPublication(ownerId: string): Promise<void>
  removeRegistration(ownerId: string, deviceId: string): Promise<void>
}

/** No HTTP contract or retry timer. Cancellation is an explicit failed/expired
 * finalizer after receipt removal; a pending/deleted result never releases it.
 */
export async function composeAndroidAccountClosure(input: {
  ownerId: string
  requests: AccountClosureRequestActions
  journal: AccountClosureJournal
}, dependencies: AndroidClosureDependencies) {
  let deviceId: string | null = null
  let terminal: PhoneCloseAcknowledgement['status'] | null = null
  let cancellationFailure: unknown
  let cancellationFailed = false
  const remember = (result: PhoneCloseAcknowledgement) => { terminal = result.status; return result }
  const native: AccountClosureNative = {
    receipt: {
      put: (scope, receipt) => dependencies.native.receipt.put(scope, receipt),
      get: scope => dependencies.native.receipt.get(scope),
      async remove(scope) {
        await dependencies.native.receipt.remove(scope)
        if (terminal === 'failed' || terminal === 'expired') {
          try { await dependencies.preparation.cancel(scope) }
          catch (error) { cancellationFailed = true; cancellationFailure = error ?? Object.assign(new Error('Preparation cancellation failed'), { code: 'closure_storage_unavailable' }); throw cancellationFailure }
        }
      },
    },
    eraseLocal: scope => dependencies.native.eraseLocal(scope),
  }
  const flow = await composePhoneAccountClosure({
    platform: 'android', ownerId: input.ownerId, journal: input.journal,
    currentOwnerId: dependencies.currentOwnerId, native,
    requests: {
      async closeAccount(request) { terminal = null; return remember(await input.requests.closeAccount(request)) },
      async readResult(request) { return remember(await input.requests.readResult(request)) },
    },
    async stopAgent() {
      const prepared = await dependencies.preparation.prepare(input.ownerId)
      deviceId = prepared.deviceId
      await dependencies.stopPublication(input.ownerId)
      return { confirmed: true }
    },
    async removeDevice() {
      if (!deviceId) throw Object.assign(new Error('Phone closure is not prepared'), { code: 'closure_not_prepared' })
      await dependencies.removeRegistration(input.ownerId, deviceId)
      await dependencies.preparation.retire(input.ownerId, deviceId)
      return { confirmed: true }
    },
  })
  // The shared cleanup intentionally retains failed custody. Preserve that
  // state, while also exposing a preparation-cancellation failure to callers.
  const checked = async (run: () => Promise<void>) => {
    await run()
    if (cancellationFailed) throw cancellationFailure
  }
  if (cancellationFailed) throw cancellationFailure
  return { ...flow,
    start: () => checked(flow.start), retry: () => checked(flow.retry),
    checkResult: () => checked(flow.checkResult), retryLocal: () => checked(flow.retryLocal),
  }
}
