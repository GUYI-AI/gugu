type Request = { id: number; agentOption: boolean; finish(value: boolean | null): void }
let current: Request | null = null
let sequence = 0
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }
export const readConversationDeleteConfirmation = () => current
export const subscribeConversationDeleteConfirmation = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The authenticated shell hosts this choice, including the phone's list-only screen. */
export function requestConversationDeleteConfirmation(signal: AbortSignal, agentOption: boolean): Promise<boolean | null> {
  if (signal.aborted) return Promise.resolve(null)
  current?.finish(null)
  return new Promise(resolve => {
    const cancel = () => request.finish(null)
    let finished = false
    const request: Request = { id: ++sequence, agentOption, finish(value) {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', cancel)
      if (current === request) { current = null; changed() }
      resolve(value)
    } }
    current = request
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    else changed()
  })
}
