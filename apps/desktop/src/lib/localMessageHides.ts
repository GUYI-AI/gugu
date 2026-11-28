import { historyTime } from '@gugu/core/shared/conversationHistoryTime'
import type { ImMessageWrite } from '../session/shared/core/im-messages'

// @@@local-hide - deleting a message or clearing a conversation hides it on this device only: nothing is sent, other
// devices and other members keep it. The local message store is the only record (its tombstone and history cutoff,
// which it applies to every later arrival); logout empties it, and the hidden messages come back. List rows, quote
// reads and search ask the store (`hidden`); this module only builds the writes and tells who shows them.

/** What a local write hid: these messages, or everything up to a cutoff. */
export type LocalHide = { chatId: string; ids: string[]; clearedAt?: string }
const listeners = new Set<(accountId: string, hide: LocalHide) => void>()

export function hideMessageWrites(chatId: string, messageId: string): ImMessageWrite[] {
  return [{ type: 'delete', chatId, id: messageId }]
}

/** The newest settled message this device shows of a conversation: its window rows, or its list row's latest. */
export function newestShown(rows: readonly { seq: number; created_at: string }[], listed?: string | null): string | null {
  return rows.reduce<string | null>((newest, row) => row.seq > 0 && (!newest || historyTime(row.created_at) > historyTime(newest))
    ? row.created_at : newest, listed ?? null)
}

/** `through`: the newest message this device shows; it and everything before it are cleared, later arrivals are not. */
export function clearChatWrites(chatId: string, through: string): ImMessageWrite[] {
  // One microsecond past it: a message created at the cutoff itself stays visible (historyMessageVisible).
  const after = historyTime(through) / 1000n + 1n
  const clearedAt = `${new Date(Number(after / 1000n)).toISOString().slice(0, -1)}${String(after % 1000n).padStart(3, '0')}Z`
  return [{ type: 'chatAccess', access: { chatId, clearedAt } }]
}

/** The hides a batch asks for, by chat; the message ingest reports them once the store has them. */
export function localHidesOf(writes: readonly ImMessageWrite[]): LocalHide[] {
  const hides = new Map<string, LocalHide>()
  const of = (chatId: string) => hides.get(chatId) ?? hides.set(chatId, { chatId, ids: [] }).get(chatId)!
  for (const write of writes) {
    if (write.type === 'delete') of(write.chatId).ids.push(write.id)
    else if (write.type === 'chatAccess' && write.access.clearedAt) of(write.access.chatId).clearedAt = write.access.clearedAt
  }
  return [...hides.values()]
}

export function announceLocalHides(accountId: string, hides: readonly LocalHide[]): void {
  for (const hide of hides) for (const listener of listeners) listener(accountId, hide)
}

export function subscribeLocalHides(listener: (accountId: string, hide: LocalHide) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
