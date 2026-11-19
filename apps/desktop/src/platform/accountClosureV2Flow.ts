import { isAccountClosureV2ErrorCode } from './accountClosureV2'
import type { AccountClosureV2ErrorCode, AccountClosureV2Confirmation, AccountClosureV2Native, AccountClosureV2Policy, AccountClosureV2Snapshot } from './accountClosureV2'

export type AccountClosureV2PolicyRead = { status: 'unread' } | { status: 'known'; value: AccountClosureV2Policy } | { status: 'failed'; code: string }
export interface AccountClosureV2FlowState {
  policy: AccountClosureV2PolicyRead
  operation: AccountClosureV2Snapshot | null
  busy: boolean
  error: string | null
}
export interface AccountClosureV2FlowPorts {
  native: AccountClosureV2Native
  /** Clear only this captured account's renderer auth/caches/subscriptions.
   * The integration must reject a current different account, never sign B out.
   */
  finalizeOwner(ownerId: string): Promise<void>
}
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }) }
const errorCode = (error: unknown): AccountClosureV2ErrorCode => {
  const code = (error as { code?: unknown } | null)?.code
  return isAccountClosureV2ErrorCode(code) ? code : 'closure_unavailable'
}

/** One shared command sequence for desktop and phone. It never holds wire
 * credentials, schedules destructive retries, or manufactures a native result.
 * A new instance recovers from native custody, not a browser journal.
 */
export function createAccountClosureV2Flow(ports: AccountClosureV2FlowPorts) {
  const state: AccountClosureV2FlowState = { policy: { status: 'unread' }, operation: null, busy: false, error: null }
  const view = (): AccountClosureV2FlowState => structuredClone(state)
  const operation = () => state.operation ?? fail('closure_context_missing')
  const admitted = () => {
    if (state.policy.status !== 'known') return fail('closure_unavailable')
    if (!state.policy.value.available) return fail('closure_not_available')
  }
  async function run(work: () => Promise<void>) {
    if (state.busy) return fail('closure_busy')
    state.busy = true; state.error = null
    try { await work() }
    catch (error) {
      const code = errorCode(error)
      // Refresh only original discovery. A failure cannot silently create an
      // operation, resend a code, confirm, or clear a protected pending record.
      try { state.operation = await ports.native.discover() }
      catch { state.operation = null }
      state.error = code
      return fail(code)
    } finally { state.busy = false }
    return view()
  }
  const accept = (value: AccountClosureV2Snapshot) => { state.operation = value }
  return {
    getState: view,
    refresh: () => run(async () => {
      // Recovery precedes admission, including when Auth is gone or gates close.
      state.operation = await ports.native.discover()
      try { state.policy = { status: 'known', value: await ports.native.readPolicy() } }
      catch (error) { state.policy = { status: 'failed', code: errorCode(error) }; state.error = errorCode(error) }
    }),
    sendCode: () => run(async () => {
      admitted()
      if (!state.operation) accept(await ports.native.capture())
      const current = operation()
      if (current.recoveryOnly) return fail('closure_recovery_required')
      accept(await ports.native.sendCode(current.handle))
    }),
    confirm: (input: AccountClosureV2Confirmation) => run(async () => {
      admitted()
      let current = operation()
      if (current.recoveryOnly) return fail('closure_recovery_required')
      if (current.phase !== 'prepared') {
        accept(await ports.native.prepare(current.handle))
        current = operation()
      }
      if (current.phase !== 'prepared' || current.recoveryOnly || !current.serverPreparationGeneration) return fail('closure_not_prepared')
      accept(await ports.native.confirm(current.handle, input))
    }),
    recover: () => run(async () => { accept(await ports.native.recover(operation().handle)) }),
    cancel: () => run(async () => {
      const current = operation()
      if (current.recoveryOnly || ['confirming', 'processing', 'deleted', 'local-complete', 'finalized'].includes(current.phase)) return fail('closure_recovery_required')
      accept(await ports.native.cancel(current.handle))
    }),
    finalize: () => run(async () => {
      const current = operation()
      if (current.phase !== 'local-complete' || current.serverOperation?.state !== 'deleted') return fail('closure_not_complete')
      await ports.finalizeOwner(current.ownerId)
      accept(await ports.native.finalize(current.handle))
      if (operation().phase !== 'finalized') return fail('closure_not_complete')
    }),
  }
}
