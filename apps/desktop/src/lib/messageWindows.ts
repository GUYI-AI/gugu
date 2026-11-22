import type { MessageItem } from '@gugu/core/shared/types/chat'
import { orderMessages } from '@gugu/core/shared/ui/messageTimeline'
import { shallowEqualMessage } from '@gugu/core/shared/ui/messageListModels'
import type { ImMessageWrite } from '../session/shared/core/im-messages'
import { MAX_WINDOW } from '../store/chatMessageWindow'

type Window = { chatId: string; root: string | null; rows: MessageItem[] }
const accounts = new Map<string, Map<string, Window>>()
/** Accounts whose local history was explicitly cleared (logout): a late write must not bring it back until they open again. */
const closed = new Set<string>()
/** Each open (or close) of an account starts a new generation of its windows. */
const generations = new Map<string, number>()
export function messageWindowGeneration(accountId: string): number { return generations.get(accountId) ?? 0 }
const nextGeneration = (accountId: string) => generations.set(accountId, messageWindowGeneration(accountId) + 1)
const key = (chatId: string, root: string | null) => JSON.stringify([chatId, root])
/**
 * One viewport cache per account; a rebind replaces the previous one. null rows = the conversation left. Rows only add
 * to the cache, so a deletion names its ids.
 */
type Publish = (chatId: string, rows: MessageItem[] | null, deletedIds?: readonly string[]) => void
const publishers = new Map<string, Publish>()

export function publishMessageWindows(accountId: string, publish: Publish): void {
  publishers.set(accountId, publish)
}

/** Opening an account starts its windows from the store (they are a mirror of it); prefetch publishes them again. */
export function initializeMessageWindows(accountId: string): void {
  closed.delete(accountId)
  nextGeneration(accountId)
  accounts.set(accountId, new Map())
}

export function setMessageWindow(accountId: string, chatId: string, root: string | null, rows: readonly MessageItem[]): void {
  const windows = accounts.get(accountId)
  if (!windows) return
  if (root) for (const [id, window] of windows) if (window.chatId === chatId && window.root && window.root !== root) windows.delete(id)
  // A store read returns fresh objects for unchanged rows: keep the published ones, and publish only a real change.
  const previous = windows.get(key(chatId, root))?.rows ?? []
  const shown = new Map(previous.map(row => [row.id, row]))
  const sorted = orderMessages(rows).slice(-MAX_WINDOW).map(row => { const old = shown.get(row.id); return old && shallowEqualMessage(old, row) ? old : row })
  windows.set(key(chatId, root), { chatId, root, rows: sorted })
  const unchanged = previous.length === sorted.length && sorted.every((row, index) => row === previous[index])
  if (!root && !unchanged) publishers.get(accountId)?.(chatId, sorted)
}

/** Null means the account is not open (logged out or not yet initialized). An empty window is still authoritative. */
export function messageWindow(accountId: string, chatId: string, root: string | null = null): MessageItem[] | null {
  return accounts.has(accountId) ? accounts.get(accountId)!.get(key(chatId, root))?.rows ?? [] : null
}

/** Return streams needing a query: deletions can expose older rows outside the bounded map. */
export function acceptMessageWrites(accountId: string, writes: readonly ImMessageWrite[]): { chatId: string; root: string | null }[] {
  const windows = accounts.get(accountId)
  if (!windows) return []
  const reads = new Map<string, { chatId: string; root: string | null }>()
  for (const write of writes) {
    if (write.type === 'deleteChat') {
      for (const [id, window] of windows) if (window.chatId === write.chatId) windows.delete(id)
      publishers.get(accountId)?.(write.chatId, null)
    } else if (write.type === 'put') {
      const row = write.message, root = row.thread_root_id ?? null, id = key(row.chat_id, root)
      if (!root || windows.has(id)) {
        reads.set(id, { chatId: row.chat_id, root })
        setMessageWindow(accountId, row.chat_id, root, [...windows.get(id)?.rows.filter(value => value.id !== row.id) ?? [], row])
      }
      for (const [threadId, window] of windows) if (window.chatId === row.chat_id && window.root === row.id) {
        reads.set(threadId, { chatId: row.chat_id, root: window.root })
      }
    } else if (write.type === 'delete') {
      for (const [id, window] of windows) if (window.chatId === write.chatId) {
        window.rows = window.rows.filter(row => row.id !== write.id)
        reads.set(id, { chatId: window.chatId, root: window.root })
      }
      publishers.get(accountId)?.(write.chatId, [], [write.id])
    }
  }
  return [...reads.values()]
}

export function clearMessageWindows(accountId: string): void { accounts.delete(accountId); closed.add(accountId); nextGeneration(accountId) }

/** Logged out on this device since it last opened. An account not opened yet is not closed: its writes simply land. */
export function messageAccountClosed(accountId: string): boolean { return closed.has(accountId) }
