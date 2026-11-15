import type { AccountClosureLocalCleanup } from './accountClosureLocalCleanup'
export type PhoneClosurePhase = 'stop-agent' | 'remove-device' | 'close-account' | 'erase-local'
export type PhoneClosureState =
  | { status: 'idle' }
  | { status: 'running'; phase: PhoneClosurePhase }
  | { status: 'failed'; phase: PhoneClosurePhase; canRetry: boolean }
  | { status: 'unconfirmed'; phase: 'close-account' }
  | { status: 'local-pending'; phase: 'erase-local' }
  | { status: 'closed' }

export type PhoneCleanupAcknowledgement = { confirmed: true } | { confirmed: false; canRetry: boolean }
export type PhoneCloseAcknowledgement = { status: 'deleted' } | { status: 'processing' } | { status: 'retry_wait'; canRetry: boolean } | { status: 'failed' | 'expired' }

/** Injected actions only: these types are not a network or native bridge contract. */
export interface PhoneAccountClosureActions {
  platform: 'android' | 'ios'
  stopAgent: () => Promise<PhoneCleanupAcknowledgement>
  removeDevice: () => Promise<PhoneCleanupAcknowledgement>
  closeAccount: () => Promise<PhoneCloseAcknowledgement>
  /** The adapter returns processing after its bounded polling budget; this read never submits closure again. */
  readResult: () => Promise<PhoneCloseAcknowledgement>
  localCleanup: AccountClosureLocalCleanup
}

export type PhoneAccountClosureFlow = ReturnType<typeof createPhoneAccountClosureFlow>

/** An earlier step must explicitly confirm success while the account is still usable. */
export function createPhoneAccountClosureFlow(actions: PhoneAccountClosureActions) {
  const phases: readonly PhoneClosurePhase[] = ['stop-agent', 'remove-device', 'close-account']
  let state: PhoneClosureState = { status: 'idle' }
  let next = 0
  let epoch = 0
  let running: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const publish = (value: PhoneClosureState) => { state = value; for (const listener of listeners) listener() }

  async function acceptResult(result: PhoneCloseAcknowledgement, current: number) {
    if (current !== epoch) return
    if (result?.status === 'deleted') {
      publish({ status: 'running', phase: 'erase-local' })
      const cleanup = await actions.localCleanup.finish('deleted')
      if (current !== epoch) return
      publish(cleanup.status === 'complete' ? { status: 'closed' } : { status: 'local-pending', phase: 'erase-local' })
    }
    else if (result?.status === 'retry_wait') publish({ status: 'failed', phase: 'close-account', canRetry: result.canRetry === true })
    else if (result?.status === 'failed' || result?.status === 'expired') {
      await actions.localCleanup.finish(result.status)
      if (current === epoch) publish({ status: 'failed', phase: 'close-account', canRetry: false })
    }
    else publish({ status: 'unconfirmed', phase: 'close-account' })
  }

  function execute(): Promise<void> {
    const current = epoch
    const task = async () => {
      while (next < phases.length) {
        const phase = phases[next]!
        publish({ status: 'running', phase })
        try {
          if (phase === 'close-account') {
            const result = await actions.closeAccount()
            if (current !== epoch) return
            await acceptResult(result, current)
            return
          }
          const result = await (phase === 'stop-agent' ? actions.stopAgent() : actions.removeDevice())
          if (current !== epoch) return
          if (result?.confirmed !== true) {
            publish({ status: 'failed', phase, canRetry: result?.confirmed === false && result.canRetry === true })
            return
          }
          next += 1
        } catch {
          if (current !== epoch) return
          // A lost close response is not proof of failure and must never authorize resubmission.
          publish(phase === 'close-account' ? { status: 'unconfirmed', phase } : { status: 'failed', phase, canRetry: false })
          return
        }
      }
    }
    running = task().finally(() => { if (current === epoch) running = null })
    return running
  }

  return {
    platform: actions.platform,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => state.status === 'idle' && !running ? execute() : running ?? Promise.resolve(),
    retry: () => state.status === 'failed' && state.canRetry && !running ? execute() : running ?? Promise.resolve(),
    checkResult: () => {
      if (state.status !== 'unconfirmed' || running) return running ?? Promise.resolve()
      const current = epoch
      publish({ status: 'running', phase: 'close-account' })
      running = Promise.resolve().then(() => actions.readResult()).then(result => acceptResult(result, current)).catch(() => {
        if (current === epoch) publish({ status: 'unconfirmed', phase: 'close-account' })
      }).finally(() => { if (current === epoch) running = null })
      return running
    },
    retryLocal: async () => {
      if (state.status !== 'local-pending' || running) return
      const current = epoch
      publish({ status: 'running', phase: 'erase-local' })
      const result = await actions.localCleanup.finish('deleted')
      if (current === epoch) publish(result.status === 'complete' ? { status: 'closed' } : { status: 'local-pending', phase: 'erase-local' })
    },
    cancel: () => {
      actions.localCleanup.cancel()
      epoch += 1
      running = null
      if (state.status === 'running') publish(state.phase === 'close-account'
        ? { status: 'unconfirmed', phase: state.phase }
        : { status: 'failed', phase: state.phase, canRetry: false })
    },
  }
}
