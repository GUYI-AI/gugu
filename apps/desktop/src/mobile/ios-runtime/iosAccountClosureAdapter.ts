import { getRendererSession } from '@/lib/sessionPublication'
import { nativeIOSAccountClosure } from '@/platform/iosAccountClosure'
import { composePhoneAccountClosure, type AccountClosureRequestActions } from '@/components/settings/accountDeletion/accountClosureComposition'
import { createAccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureJournal'
import type { AccountClosureJournal } from '@/components/settings/accountDeletion/accountClosureLocalCleanup'
import type { AccountClosureNative } from '@/platform/accountClosure'
import type { PhoneCloseAcknowledgement } from '@/components/settings/accountDeletion/phoneAccountClosureFlow'
import { cancelIOSSignOut, iosOwnerClient, prepareIOSSignOut } from './iosOwnerClient'

/** The shared controller owns ordering. Native methods validate their explicit
 * acknowledgements before this adapter confirms the next step.
 * No Auth sign-out, Keychain write or generic cascading device deletion here.
 */
export async function createIOSAccountClosureFlow(input: {
  ownerId: string
  requests: AccountClosureRequestActions
  journal?: AccountClosureJournal
}) {
  let journal: AccountClosureJournal
  try { journal = input.journal ?? createAccountClosureJournal(globalThis.localStorage) }
  catch { throw Object.assign(new Error('closure_storage_unavailable'), { code: 'closure_storage_unavailable' }) }
  let terminal: PhoneCloseAcknowledgement['status'] | null = null
  let cancellationFailed = false
  let cancellationFailure: unknown
  const remember = (result: PhoneCloseAcknowledgement) => { terminal = result?.status ?? null; return result }
  const native: AccountClosureNative = {
    receipt: {
      put: (scope, receipt) => nativeIOSAccountClosure.receipt.put(scope, receipt),
      get: scope => nativeIOSAccountClosure.receipt.get(scope),
      async remove(scope) {
        await nativeIOSAccountClosure.receipt.remove(scope)
        if (terminal === 'failed' || terminal === 'expired') {
          try { await cancelIOSSignOut(scope.ownerId, scope.localOperationId) }
          catch (error) {
            cancellationFailed = true
            cancellationFailure = error ?? Object.assign(new Error('Preparation cancellation failed'), { code: 'closure_storage_unavailable' })
            throw cancellationFailure
          }
        }
      },
    },
    eraseLocal: scope => nativeIOSAccountClosure.eraseLocal(scope),
  }
  const flow = await composePhoneAccountClosure({
    platform: 'ios', ownerId: input.ownerId,
    currentOwnerId: () => getRendererSession()?.user.id ?? null,
    native,
    journal,
    requests: {
      async closeAccount(request) { terminal = null; return remember(await input.requests.closeAccount(request)) },
      async readResult(request) { return remember(await input.requests.readResult(request)) },
    },
    stopAgent: async () => { await prepareIOSSignOut(input.ownerId); return { confirmed: true } },
    removeDevice: async () => { await iosOwnerClient.retire(input.ownerId); return { confirmed: true } },
  })
  // Cleanup keeps its failed state; also surface cancellation failure to callers.
  const checked = async (run: () => Promise<void>) => { await run(); if (cancellationFailed) throw cancellationFailure }
  if (cancellationFailed) throw cancellationFailure
  return { ...flow,
    start: () => checked(flow.start), retry: () => checked(flow.retry),
    checkResult: () => checked(flow.checkResult), retryLocal: () => checked(flow.retryLocal),
  }
}
