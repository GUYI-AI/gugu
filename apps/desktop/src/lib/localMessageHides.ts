import { historyMessageVisible, historyTime } from '@gugu/core/shared/conversationHistoryTime'
import type { ImMessageWrite } from '../session/shared/core/im-messages'

// @@@local-hide - deleting a message or clearing a conversation hides it on this device only: nothing is sent, other
// devices and other members keep it. The intent lives here, beside the message store and outliving it (logout empties
// the store, not this); the store gets the same facts as its tombstone and history cutoff, and list rows, quote reads
// and search ask isMessageHidden.

type Hides = { messages: Record<string, string[]>; cleared: Record<string, string> }
const KEY = (accountId: string) => `gugu.localMessageHides.v1:${accountId}`
const loaded = new Map<string, Hides>()
const listeners = new Set<(accountId: string, chatId: string) => void>()

function hides(accountId: string): Hides {
  let value = loaded.get(accountId)
  if (!value) {
    const stored = JSON.parse(globalThis.localStorage?.getItem(KEY(accountId)) ?? 'null') as Hides | null
    loaded.set(accountId, value = stored ?? { messages: {}, cleared: {} })
  }
  return value
}

function save(accountId: string, chatId: string): void {
  globalThis.localStorage?.setItem(KEY(accountId), JSON.stringify(hides(accountId)))
  for (const listener of listeners) listener(accountId, chatId)
}

export function hideMessageLocally(accountId: string, chatId: string, messageId: string): ImMessageWrite[] {
  const ids = hides(accountId).messages[chatId] ??= []
  if (!ids.includes(messageId)) { ids.push(messageId); save(accountId, chatId) }
  return [{ type: 'delete', chatId, id: messageId }]
}

/** The newest settled message this device shows of a conversation: its window rows, or its list row's latest. */
export function newestShown(rows: readonly { seq: number; created_at: string }[], listed?: string | null): string | null {
  return rows.reduce<string | null>((newest, row) => row.seq > 0 && (!newest || historyTime(row.created_at) > historyTime(newest))
    ? row.created_at : newest, listed ?? null)
}

/** `through`: the newest message this device shows; it and everything before it are cleared, later arrivals are not. */
export function clearChatLocally(accountId: string, chatId: string, through: string): ImMessageWrite[] {
  // One microsecond past it: a message created at the cutoff itself stays visible (historyMessageVisible).
  const after = historyTime(through) / 1000n + 1n
  const at = `${new Date(Number(after / 1000n)).toISOString().slice(0, -1)}${String(after % 1000n).padStart(3, '0')}Z`
  const state = hides(accountId)
  if (later(state.cleared[chatId], at) !== state.cleared[chatId]) { state.cleared[chatId] = at; save(accountId, chatId) }
  return [{ type: 'chatAccess', access: { chatId, clearedAt: state.cleared[chatId] } }]
}

/** The later of two history cutoffs. */
function later(a: string | null | undefined, b: string | null | undefined): string | undefined {
  return !a || (b && historyTime(b) > historyTime(a)) ? b ?? undefined : a
}

export type LocalHides = {
  /** This device's cutoff or `server`'s, whichever is later. */
  clearedAt(chatId: string, server?: string | null): string | undefined
  hidden(message: { id: string; chat_id: string; created_at: string }): boolean
}

export function localHidesOf(accountId: string): LocalHides {
  return { clearedAt: (chatId, server) => later(hides(accountId).cleared[chatId], server), hidden: message => isMessageHidden(accountId, message) }
}

export function isMessageHidden(accountId: string, message: { id: string; chat_id: string; created_at: string }): boolean {
  const state = hides(accountId)
  return !!state.messages[message.chat_id]?.includes(message.id)
    || !historyMessageVisible(message.created_at, state.cleared[message.chat_id])
}

/** Every hide as store writes: an account opened after logout starts from an empty store. */
export function localHideWrites(accountId: string): ImMessageWrite[] {
  const state = hides(accountId)
  return [
    ...Object.entries(state.messages).flatMap(([chatId, ids]) => ids.map(id => ({ type: 'delete' as const, chatId, id }))),
    ...Object.entries(state.cleared).map(([chatId, clearedAt]) => ({ type: 'chatAccess' as const, access: { chatId, clearedAt } })),
  ]
}

export function subscribeLocalHides(listener: (accountId: string, chatId: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
