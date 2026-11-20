import { createAccountClosureV2Flow, type AccountClosureV2FlowState } from '../../../platform/accountClosureV2Flow'
import type { AccountClosureV2Confirmation, AccountClosureV2Native } from '../../../platform/accountClosureV2'

/** App and Settings share this one native-led execution flow. There is no renderer
 * receipt journal, local success inference or automatic destructive retry.
 */
export function createAccountClosureV2Controller(native: AccountClosureV2Native, finalizeOwner: (ownerId: string) => Promise<void>, onFinalized: (ownerId: string) => void = () => {}) {
  const flow = createAccountClosureV2Flow({ native, finalizeOwner })
  const listeners = new Set<() => void>()
  let snapshot = flow.getState()
  let recoveryRequested = false
  let recovering: Promise<void> | null = null
  const announced = new Set<string>()
  const resumeRecovery = () => {
    if (recoveryRequested && !recovering && !flow.getState().busy) void recoverOriginal().catch(() => undefined)
  }
  const emit = () => { snapshot = flow.getState(); listeners.forEach(listener => listener()) }
  async function command<T>(work: () => Promise<T>): Promise<T> {
    const pending = work(); emit()
    try {
      const result = await pending
      const operation = flow.getState().operation
      if (operation?.phase === 'finalized' && !announced.has(operation.handle.localOperationId)) {
        announced.add(operation.handle.localOperationId)
        try { onFinalized(operation.ownerId) } catch { /* A notice failure cannot undo native completion. */ }
      }
      return result
    }
    finally { emit() }
  }
  const recoverOriginal = (): Promise<void> => {
    recoveryRequested = true
    if (recovering) return recovering
    const run = async () => {
      while (recoveryRequested) {
        recoveryRequested = false
        // An existing UI command owns the single flow until it settles. Its
        // finally block publishes the new original handle before another read.
        if (flow.getState().busy) { recoveryRequested = true; return }
        await command(flow.refresh)
        let operation = flow.getState().operation
        if (!operation || operation.phase === 'finalized' || operation.phase === 'cancelled') continue
        if (operation.phase !== 'local-complete') {
          await command(flow.recover)
          operation = flow.getState().operation
        }
        if (operation?.phase === 'local-complete') await command(flow.finalize)
      }
    }
    const pending = run()
    recovering = pending.finally(() => { recovering = null; queueMicrotask(resumeRecovery) })
    return recovering
  }
  const userCommand = async <T>(work: () => Promise<T>) => {
    try { return await command(work) }
    finally { if (recoveryRequested) queueMicrotask(resumeRecovery) }
  }
  return {
    getSnapshot: (): AccountClosureV2FlowState => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    refresh: () => userCommand(flow.refresh),
    sendCode: () => userCommand(flow.sendCode),
    confirm: (input: AccountClosureV2Confirmation) => userCommand(() => flow.confirm(input)),
    recover: () => userCommand(flow.recover),
    cancel: () => userCommand(flow.cancel),
    finalize: () => userCommand(flow.finalize),
    recoverOriginal,
  }
}
