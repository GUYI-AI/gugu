import type { AccountClosureNative, AccountClosureScope } from '@/platform/accountClosure'
export type { AccountClosureNative, AccountClosureScope } from '@/platform/accountClosure'
/** Only non-secret scope metadata belongs here. The opaque receipt stays in native encrypted storage. */
export interface AccountClosureJournal {
  write(scope: AccountClosureScope): Promise<void>
  read(ownerId: string): Promise<AccountClosureScope | null>
  remove(scope: AccountClosureScope): Promise<void>
}
export type ClosureCleanupState = { status: 'idle' | 'running' | 'pending' | 'complete' | 'failed' | 'unconfirmed'; retainedUnattributed: readonly string[] }
export type AccountClosureLocalCleanup = ReturnType<typeof createAccountClosureLocalCleanup>
export async function restoreAccountClosureScope(ownerId: string, journal: AccountClosureJournal): Promise<AccountClosureScope | null> {
  const scope = await journal.read(ownerId)
  if (!scope) return null
  if (scope.ownerId !== ownerId || !scope.localOperationId) throw new Error('Account closure scope mismatch')
  return Object.freeze({ ownerId: scope.ownerId, localOperationId: scope.localOperationId })
}

/** Product default pending confirmation: at most five erase attempts, two seconds apart. Native has no timer. */
export function createAccountClosureLocalCleanup(input: { scope: AccountClosureScope; native: AccountClosureNative; journal: AccountClosureJournal }) {
  const scope = Object.freeze({ ...input.scope })
  let state: ClosureCleanupState = { status: 'idle', retainedUnattributed: [] }
  let running: Promise<ClosureCleanupState> | null = null
  let epoch = 0
  let cancelWait: (() => void) | undefined
  let erased = false
  let decidedTerminal: 'deleted' | 'failed' | 'expired' | null = null
  const set = (status: ClosureCleanupState['status']) => { state = { ...state, status }; return state }
  const wait = () => new Promise<void>(resolve => {
    const finish = () => { cancelWait = undefined; resolve() }
    const timer = setTimeout(finish, 2000)
    cancelWait = () => { clearTimeout(timer); finish() }
  })
  const finish = (terminal: 'deleted' | 'failed' | 'expired'): Promise<ClosureCleanupState> => {
    if (decidedTerminal && decidedTerminal !== terminal) return Promise.resolve(set('failed'))
    decidedTerminal = terminal
    if (running) return running
    if (state.status === 'complete') return Promise.resolve(state)
    const current = epoch
    set('running')
    const work = async (): Promise<ClosureCleanupState> => {
      try {
        if (terminal === 'deleted' && !erased) {
          const receipt = await input.native.receipt.get(scope)
          if (current !== epoch) return set('pending')
          if (receipt === null) return set('unconfirmed')
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const result = await input.native.eraseLocal(scope)
            if (current !== epoch) return set('pending')
            if (!result || !Array.isArray(result.retainedUnattributed) || !result.retainedUnattributed.every(item => typeof item === 'string')) throw new Error('Invalid native cleanup acknowledgement')
            state = { ...state, retainedUnattributed: [...result.retainedUnattributed] }
            if (result.status === 'complete') { erased = true; break }
            if (result.status !== 'pending') throw new Error('Invalid native cleanup status')
            if (attempt === 4) return set('pending')
            await wait()
            if (current !== epoch) return set('pending')
          }
        }
        if (current !== epoch) return set('pending')
        // A pending erase never reaches remove. failed/expired never reach erase.
        await input.native.receipt.remove(scope)
        if (current !== epoch) return set('pending')
        await input.journal.remove(scope)
        return set('complete')
      } catch { return set('failed') }
    }
    running = work().finally(() => { running = null })
    return running
  }
  return { finish, getSnapshot: () => state, cancel: () => { epoch += 1; cancelWait?.() } }
}
