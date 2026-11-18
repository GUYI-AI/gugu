import type { PersonalConversationStateReceipt } from './hideListedConversation'

type PendingHide<Receipt> = { operationId: string; boundary: AbortSignal; receipt?: Receipt; inFlight?: Promise<Receipt | undefined> }

/** No automatic replay. Explicit retries retain their operation and any confirmed receipt. */
export function createConversationHider<Receipt extends PersonalConversationStateReceipt>(deps: {
  hide: (chatId: string, operationId: string) => Promise<Receipt>
  confirm: (accountId: string, receipt: Receipt) => Promise<void>
  boundary: () => AbortSignal
  operationId: () => string
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  storageKey?: string
}) {
  const pending = new Map<string, PendingHide<Receipt>>()
  return (accountId: string, chatId: string): Promise<Receipt | undefined> => {
    const key = `${accountId}/${chatId}`, boundary = deps.boundary()
    if (boundary.aborted) return Promise.resolve(undefined)
    let entry = pending.get(key)
    if (!entry || entry.boundary !== boundary) {
      const saved = deps.storage?.getItem(`${deps.storageKey}:${key}`)
      const held = saved ? JSON.parse(saved) as Pick<PendingHide<Receipt>, 'operationId' | 'receipt'> : undefined
      entry = { operationId: held?.operationId ?? deps.operationId(), ...(held?.receipt ? { receipt: held.receipt } : {}), boundary }
      pending.set(key, entry)
    }
    if (entry.inFlight) return entry.inFlight
    const current = entry
    const request = async () => {
      const save = () => deps.storage?.setItem(`${deps.storageKey}:${key}`, JSON.stringify({ operationId: current.operationId, receipt: current.receipt }))
      save()
      current.receipt ??= await deps.hide(chatId, current.operationId)
      save()
      if (boundary.aborted) return
      await deps.confirm(accountId, current.receipt)
      if (boundary.aborted) return
      deps.storage?.removeItem(`${deps.storageKey}:${key}`)
      if (pending.get(key) === current) pending.delete(key)
      return current.receipt
    }
    current.inFlight = request().finally(() => { current.inFlight = undefined })
    return current.inFlight
  }
}
