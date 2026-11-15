import type { AccountClosureErrorCode, AccountClosureNative, AccountClosureScope } from '@/platform/accountClosure'
import { createAccountClosureLocalCleanup, restoreAccountClosureScope, type AccountClosureJournal, type AccountClosureLocalCleanup, type ClosureCleanupState } from './accountClosureLocalCleanup'
import { createPhoneAccountClosureFlow, type PhoneAccountClosureActions, type PhoneAccountClosureFlow, type PhoneCloseAcknowledgement } from './phoneAccountClosureFlow'

/** Internal injected actions, not an HTTP contract. Opaque receipts must stay
 * out of URLs/logs. The caller binds retries to this same captured operation.
 */
export interface AccountClosureRequestActions {
  closeAccount(input: {
    scope: AccountClosureScope
    receipt: string | null
    captureReceipt: (receipt: string) => Promise<void>
  }): Promise<PhoneCloseAcknowledgement>
  readResult(input: { scope: AccountClosureScope; receipt: string }): Promise<PhoneCloseAcknowledgement>
}
export interface AccountClosureCompositionInput extends Pick<PhoneAccountClosureActions, 'platform' | 'stopAgent' | 'removeDevice'> {
  ownerId: string
  currentOwnerId: () => string | null
  native: AccountClosureNative
  journal: AccountClosureJournal
  requests: AccountClosureRequestActions
}
const fail = (code: AccountClosureErrorCode): never => { throw Object.assign(new Error(code), { code }) }
const idle: ClosureCleanupState = { status: 'idle', retainedUnattributed: [] }

/** A persisted scope means submission may already have happened. Restore only
 * reads that operation: it never repeats live-auth cleanup or a lost close.
 */
export async function composePhoneAccountClosure(input: AccountClosureCompositionInput): Promise<PhoneAccountClosureFlow> {
  const sameOwner = (required = false) => {
    const owner = input.currentOwnerId()
    if ((required && owner !== input.ownerId) || (owner !== null && owner !== input.ownerId)) fail('wrong_local_owner')
  }
  sameOwner()
  let scope = await restoreAccountClosureScope(input.ownerId, input.journal)
  const restored = scope !== null
  sameOwner(!restored)
  let submitted = restored
  let captured = false
  let retryAllowed = false
  let cleanup: AccountClosureLocalCleanup | null = null
  const receipt = async () => {
    sameOwner()
    if (!scope) return fail('closure_context_missing')
    const value = await input.native.receipt.get(scope)
    sameOwner()
    if (value === null) return fail('receipt_missing')
    captured = true
    return value
  }
  const remember = (result: PhoneCloseAcknowledgement) => {
    retryAllowed = result?.status === 'retry_wait' && result.canRetry === true
    return result
  }
  const readResult = async () => {
    const value = await receipt()
    const result = await input.requests.readResult({ scope: scope!, receipt: value })
    sameOwner()
    return remember(result)
  }
  const localCleanup: AccountClosureLocalCleanup = {
    async finish(terminal) {
      sameOwner()
      if (!cleanup) {
        await receipt()
        cleanup = createAccountClosureLocalCleanup({ scope: scope!, native: input.native, journal: input.journal })
      }
      const result = await cleanup.finish(terminal)
      sameOwner()
      return result
    },
    getSnapshot: () => cleanup?.getSnapshot() ?? idle,
    cancel: () => cleanup?.cancel(),
  }
  const closeAccount = async () => {
    if (submitted && !retryAllowed) return readResult()
    sameOwner(!submitted)
    if (!scope) scope = Object.freeze({ ownerId: input.ownerId, localOperationId: crypto.randomUUID() })
    // Persist non-secret custody before any irreversible request. A crash here
    // is conservatively unknown; it must never create another request ID.
    await input.journal.write(scope)
    sameOwner(!submitted)
    const existingReceipt = captured ? await receipt() : null
    submitted = true
    retryAllowed = false
    const current = scope
    let captureWork = Promise.resolve()
    const captureReceipt = (value: string): Promise<void> => {
      captureWork = captureWork.then(async () => {
        sameOwner()
        await input.native.receipt.put(current, value)
        sameOwner()
        await input.journal.write(current)
        captured = true
      })
      // A caller that forgets to await its callback cannot create an unhandled
      // rejection. The final result still awaits and propagates this failure.
      void captureWork.catch(() => undefined)
      return captureWork
    }
    let result: PhoneCloseAcknowledgement
    try { result = await input.requests.closeAccount({ scope: current, receipt: existingReceipt, captureReceipt }) }
    finally { await captureWork }
    sameOwner()
    if (!captured) return fail('receipt_missing')
    await receipt()
    return remember(result)
  }
  const flow = createPhoneAccountClosureFlow({
    platform: input.platform,
    stopAgent: async () => {
      sameOwner(!restored)
      if (restored) return { confirmed: true }
      const result = await input.stopAgent()
      sameOwner(true)
      return result
    },
    removeDevice: async () => {
      sameOwner(!restored)
      if (restored) return { confirmed: true }
      const result = await input.removeDevice()
      sameOwner(true)
      return result
    },
    closeAccount, readResult, localCleanup,
  })
  if (restored) await flow.start()
  return flow
}
