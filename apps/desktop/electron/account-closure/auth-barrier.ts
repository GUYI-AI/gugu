import { AsyncLocalStorage } from 'node:async_hooks'

/** Receipt custody and main-account changes share this barrier. Internal calls
 * may re-enter it; independent IPC requests never inherit its ownership.
 */
export function createClosureAuthBarrier() {
  const active = new AsyncLocalStorage<{ open: boolean }>()
  let tail = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    if (active.getStore()?.open) return operation()
    const result = tail.then(() => active.run({ open: true }, async () => {
      try { return await operation() }
      finally { active.getStore()!.open = false }
    }))
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}
