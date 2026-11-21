import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessageState } from '@gugu/core/shared/ui/messageState'
import { historyMessageVisible, historyTime } from '@gugu/core/shared/conversationHistoryTime'
import type { ImChatAccess, ImMessageBatch, ImMessagePage, ImMessagePageResult, ImMessageRange, ImMessageWrite } from './im-messages'

// @@@client-state-model - one IM message storage contract. Every rule about which rows exist, which sequence
// ranges are verified contiguous and how a stored row merges with an arrival lives here, once. A platform supplies
// only an adapter that reads and writes one account's rows synchronously: the desktop's session SQLite, the phone's
// in-memory rows backed by IndexedDB. ❌ Put a storage rule in an adapter.

export type ChatAccessRow = {
  chatId: string
  sourceChatId: string | null
  ownMember: boolean | null
  membershipRevoked: boolean
  archived: boolean
  membershipRevision: string | null
  chatRevision: string | null
  historyClearedAt: string | null
}

export type SeqRange = { fromSeq: number; toSeq: number }

/** One account's storage. Every method is synchronous; `transaction` makes a batch all-or-nothing. */
export interface MessageStoreAdapter {
  transaction<T>(body: () => T): T
  row(id: string): { message: MessageItem; claimedRevision: string | null } | undefined
  /** Returns the row as stored (renderer-only fields dropped). */
  putRow(message: MessageItem, claimedRevision: string | null): MessageItem
  /** Without ids: every row of the chat. */
  deleteRows(chatId: string, ids?: readonly string[]): void
  /** Main stream when root is null; a thread is its replies plus the root row. Rows in query order. */
  stream(chatId: string, root: string | null, after: number, before: number, limit: number, newer: boolean): MessageItem[]
  /** Newest `limit` main-stream rows of each chat, ordered by chat then seq. */
  latest(chatIds: readonly string[], limit: number): MessageItem[]
  rows(ids: readonly string[]): MessageItem[]
  createdAt(chatId: string): { id: string; createdAt: string }[]
  /** root '' is the main stream. */
  ranges(chatId: string, root: string): SeqRange[]
  setRanges(chatId: string, root: string, ranges: readonly SeqRange[]): void
  dropRanges(chatId: string): void
  /** messageId '' is the conversation departure, which also hides every message of the chat. */
  tombstoned(chatId: string, messageId: string): boolean
  tombstone(chatId: string, messageId: string): void
  clearDeparture(chatId: string): void
  access(chatId: string): ChatAccessRow | undefined
  putAccess(row: ChatAccessRow): void
  accessChildren(sourceChatId: string): ChatAccessRow[]
  throughRevision(): string | null
  setThroughRevision(revision: string): void
  clear(): void
}

export const decimalRevision = /^(0|[1-9]\d*)$/

export function requireId(id: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new Error('Persistent messages require a scoped identity')
}

export function requireLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid persistent message page limit')
}

/** What every platform stores: no renderer-only fields, and no absent (undefined) fields, as a JSON row has none. */
export function storedForm(message: MessageItem): MessageItem {
  const value = { ...message } as Record<string, unknown>
  delete value.image_dimensions
  for (const key of Object.keys(value)) if (key.startsWith('local_send_') || value[key] === undefined) delete value[key]
  return value as unknown as MessageItem
}

/**
 * `retain`: how many newest rows of each main stream the store keeps (null: all of them). Older rows and their coverage
 * leave together, so a read below the kept rows is not covered and goes to the server.
 */
export function messageStoreOperations(store: MessageStoreAdapter, retain: number | null = null) {
  const departed = (chatId: string) => store.tombstoned(chatId, '')

  function trim(chatId: string): void {
    const kept = store.latest([chatId], retain!)
    if (kept.length < retain!) return
    const oldest = kept[0]!.seq
    const older = store.stream(chatId, null, 0, oldest, Number.MAX_SAFE_INTEGER, false)
    if (older.length) store.deleteRows(chatId, older.map(row => row.id))
    const ranges = store.ranges(chatId, '')
    if (ranges.some(range => range.fromSeq < oldest)) {
      store.setRanges(chatId, '', ranges.filter(range => range.toSeq >= oldest).map(range => ({ fromSeq: Math.max(range.fromSeq, oldest), toSeq: range.toSeq })))
    }
  }

  function cover(range: ImMessageRange): void {
    requireId(range.chatId)
    if (!Number.isSafeInteger(range.fromSeq) || !Number.isSafeInteger(range.toSeq)
      || range.fromSeq < 1 || range.toSeq < range.fromSeq) throw new Error('Invalid message coverage range')
    if (departed(range.chatId)) return
    const root = range.threadRootId ?? ''
    let from = range.fromSeq
    let to = range.toSeq
    const kept: SeqRange[] = []
    for (const existing of store.ranges(range.chatId, root)) {
      if (existing.fromSeq <= to + 1 && existing.toSeq >= from - 1) {
        from = Math.min(from, existing.fromSeq)
        to = Math.max(to, existing.toSeq)
      } else kept.push(existing)
    }
    store.setRanges(range.chatId, root, [...kept, { fromSeq: from, toSeq: to }].sort((a, b) => a.fromSeq - b.fromSeq))
  }

  /**
   * A revision-ordered arrival continues its stream's covered tail. The account revision log is contiguous, so the
   * tail stays complete even when the sequence skips numbers that other streams (thread replies) took.
   */
  function extend(message: MessageItem): void {
    const ranges = store.ranges(message.chat_id, message.thread_root_id ?? '')
    const tail = ranges.length ? Math.max(...ranges.map(range => range.toSeq)) : null
    cover({ chatId: message.chat_id, threadRootId: message.thread_root_id,
      fromSeq: tail !== null && tail < message.seq ? tail + 1 : message.seq, toSeq: message.seq })
  }

  function historyCleared(message: MessageItem): boolean {
    const seen = new Set<string>()
    for (let chatId: string | null = message.chat_id; chatId && !seen.has(chatId);) {
      seen.add(chatId)
      const access = store.access(chatId)
      if (access?.historyClearedAt && !historyMessageVisible(message.created_at, access.historyClearedAt)) return true
      chatId = access?.sourceChatId ?? null
    }
    return false
  }

  function put(message: MessageItem, revision?: string): ImMessageWrite[] {
    requireId(message.id)
    requireId(message.chat_id)
    if (!Number.isSafeInteger(message.seq)) throw new Error('Invalid message sequence')
    if (message.seq < 1 || store.tombstoned(message.chat_id, message.id) || historyCleared(message)) return []
    const old = store.row(message.id)
    // Receipts only move forward and an arrival without overlays keeps the stored ones: the same merge as the view.
    const merged = storedForm(mergeMessageState(old?.message, message))
    // @@@arrival-claim - the first revision that delivers a message claims it, even if a page fetch stored the body
    // first; the claim lives and dies with the row.
    const claims = revision !== undefined && !old?.claimedRevision
    const stored = store.putRow(merged, old?.claimedRevision ?? (claims ? revision : null))
    if (revision !== undefined) extend(stored)
    return [{ type: 'put', message: stored, ...(claims ? { claimed: true as const } : {}) }]
  }

  /** Overlay facts land on the row already stored, inside the write queue: a body read earlier cannot come back. */
  function patch(id: string, fields: Partial<MessageItem>): ImMessageWrite[] {
    requireId(id)
    const old = store.row(id)
    if (!old) return []
    const stored = store.putRow(storedForm(mergeMessageState(old.message, { ...old.message, ...fields })), old.claimedRevision)
    return [{ type: 'put', message: stored }]
  }

  function removeChat(chatId: string): ImMessageWrite {
    store.tombstone(chatId, '')
    store.deleteRows(chatId)
    store.dropRanges(chatId)
    return { type: 'deleteChat', chatId }
  }

  function descendants(chatId: string): string[] {
    const found = [chatId]
    for (let index = 0; index < found.length; index++) {
      for (const child of store.accessChildren(found[index]!)) if (!found.includes(child.chatId)) found.push(child.chatId)
    }
    return found
  }

  /** Permission facts decide which histories may stay on disk, including observer topics absent from the chat list. */
  function applyAccess(access: ImChatAccess, revision?: string): ImMessageWrite[] {
    requireId(access.chatId)
    if (access.sourceChatId != null) requireId(access.sourceChatId)
    const stamp = access.revision ?? revision
    if (stamp !== undefined && !decimalRevision.test(stamp)) throw new Error('Invalid message access revision')
    const old = store.access(access.chatId)
    const fresh = (previous: string | null | undefined) => stamp === undefined || previous == null || BigInt(stamp) >= BigInt(previous)
    const membership = (access.ownMember !== undefined || access.membershipRevoked !== undefined) && fresh(old?.membershipRevision)
    const chat = (access.sourceChatId !== undefined || access.archived !== undefined) && fresh(old?.chatRevision)
    const source = !chat || access.sourceChatId === undefined ? old?.sourceChatId ?? null : access.sourceChatId
    const member = !membership || access.ownMember === undefined ? old?.ownMember ?? null : access.ownMember
    const revoked = (membership && access.membershipRevoked) || (old?.ownMember === true && member === false)
      ? true : member === true ? false : old?.membershipRevoked ?? false
    const archived = !chat || access.archived === undefined ? old?.archived ?? false : access.archived
    store.putAccess({ chatId: access.chatId, sourceChatId: source, ownMember: member, membershipRevoked: revoked, archived,
      membershipRevision: membership ? stamp ?? old?.membershipRevision ?? null : old?.membershipRevision ?? null,
      chatRevision: chat ? stamp ?? old?.chatRevision ?? null : old?.chatRevision ?? null,
      historyClearedAt: old?.historyClearedAt ?? null })
    // Observer reads do not receive every revision. Joining starts a new coverage baseline.
    if (membership && member === true && old?.ownMember !== true) store.dropRanges(access.chatId)
    const applied: ImMessageWrite[] = []
    if (access.clearedAt && (!old?.historyClearedAt || historyTime(access.clearedAt) > historyTime(old.historyClearedAt))) {
      for (const chatId of descendants(access.chatId)) {
        const row = store.access(chatId)
        const cutoff = row?.historyClearedAt && historyTime(row.historyClearedAt) > historyTime(access.clearedAt)
          ? row.historyClearedAt : access.clearedAt
        if (row) store.putAccess({ ...row, historyClearedAt: cutoff })
        const hidden = store.createdAt(chatId).filter(stored => !historyMessageVisible(stored.createdAt, cutoff)).map(stored => stored.id)
        store.deleteRows(chatId, hidden)
        for (const id of hidden) applied.push({ type: 'delete', chatId, id })
        store.dropRanges(chatId)
      }
    }
    if (archived || revoked || (member === false && source && departed(source))) applied.push(removeChat(access.chatId))
    else if (member === true || (member === false && source && !departed(source))) store.clearDeparture(access.chatId)
    // A source membership revocation affects only locally known observer topics. Own topic memberships survive.
    if (revoked) {
      for (const child of store.accessChildren(access.chatId)) if (child.ownMember === false) applied.push(removeChat(child.chatId))
    }
    return applied
  }

  function write(operation: ImMessageWrite, revision?: string): ImMessageWrite[] {
    if (operation.type === 'put') return put(operation.message, revision)
    if (operation.type === 'patch') return patch(operation.id, operation.fields)
    if (operation.type === 'chatAccess') return applyAccess(operation.access, revision)
    requireId(operation.chatId)
    if (operation.type === 'truncateRange') {
      store.dropRanges(operation.chatId)
      return []
    }
    if (operation.type === 'delete') {
      requireId(operation.id)
      store.tombstone(operation.chatId, operation.id)
      store.deleteRows(operation.chatId, [operation.id])
      return [operation]
    }
    return applyAccess({ chatId: operation.chatId, ownMember: false, membershipRevoked: true }, revision)
  }

  function ingest(batch: ImMessageBatch): ImMessageWrite[] {
    return store.transaction(() => {
      const previous = store.throughRevision()
      const applied: ImMessageWrite[] = []
      for (const operation of batch.writes) applied.push(...write(operation))
      for (const page of batch.revisions) {
        if (!decimalRevision.test(page.revision)) throw new Error('Invalid message revision')
        // Another window or a crash before IndexedDB commit can replay a page already committed here.
        if (previous !== null && BigInt(page.revision) <= BigInt(previous)) continue
        for (const operation of page.writes) applied.push(...write(operation, page.revision))
      }
      for (const range of batch.ranges ?? []) cover(range)
      if (retain !== null) {
        for (const chatId of new Set(applied.flatMap(write => write.type === 'put' && !write.message.thread_root_id ? [write.message.chat_id] : []))) trim(chatId)
      }
      if (batch.throughRevision !== undefined) {
        if (!decimalRevision.test(batch.throughRevision)) throw new Error('Invalid message through_revision')
        if (batch.revisions.some(page => BigInt(page.revision) > BigInt(batch.throughRevision!))) {
          throw new Error('Message revision exceeds the committed cursor')
        }
        if (previous === null || BigInt(batch.throughRevision) > BigInt(previous)) store.setThroughRevision(batch.throughRevision)
      }
      return applied
    })
  }

  function page(options: ImMessagePage): ImMessagePageResult {
    requireLimit(options.limit)
    if (options.ids) {
      if (!options.ids.length || options.ids.length > 500) throw new Error('Invalid local message id page')
      options.ids.forEach(requireId)
      return { rows: store.rows(options.ids).sort((a, b) => a.seq - b.seq), covered: false }
    }
    requireId(options.chatId!)
    const before = options.beforeSeq ?? Number.MAX_SAFE_INTEGER
    const after = options.afterSeq ?? 0
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(after) || after < 0) {
      throw new Error('Invalid persistent message cursor')
    }
    const newer = options.afterSeq !== undefined
    const rows = store.stream(options.chatId!, options.threadRootId ?? null, after, before, options.limit, newer)
    if (!newer) rows.reverse()
    const bottom = rows[0]?.seq ?? 1
    const top = rows[rows.length - 1]?.seq ?? after
    const low = newer ? after + 1 : bottom
    const high = newer ? top : before - 1
    const range = store.ranges(options.chatId!, options.threadRootId ?? '').find(range => range.fromSeq <= low && range.toSeq >= high)
    return { rows, covered: !!range && (rows.length === options.limit || (!newer && range.fromSeq === 1)) }
  }

  return {
    ingest,
    page,
    windows(chatIds: readonly string[], limit: number): MessageItem[] {
      requireLimit(limit)
      chatIds.forEach(requireId)
      return store.latest(chatIds, limit)
    },
    throughRevision: () => store.throughRevision(),
    clear: () => store.transaction(() => store.clear()),
  }
}

/**
 * Chats an ingest reads or writes: its rows' chats, every topic below a chat it touches (an access change can remove
 * them) and each such chat's source (whose departure decides an observer topic's).
 */
export function chatsOfBatch(batch: ImMessageBatch, children: (chatId: string) => readonly string[],
  source: (chatId: string) => string | null): Set<string> {
  const chats = new Set<string>()
  const visit = (write: ImMessageWrite) => {
    if (write.type === 'put') chats.add(write.message.chat_id)
    else if (write.type === 'chatAccess') {
      chats.add(write.access.chatId)
      if (write.access.sourceChatId) chats.add(write.access.sourceChatId)
    }
    else chats.add(write.chatId)
  }
  for (const write of batch.writes) visit(write)
  for (const page of batch.revisions) for (const write of page.writes) visit(write)
  for (const range of batch.ranges ?? []) chats.add(range.chatId)
  const queue = [...chats]
  while (queue.length) {
    const chatId = queue.pop()!
    for (const child of children(chatId)) if (!chats.has(child)) { chats.add(child); queue.push(child) }
  }
  for (const chatId of [...chats]) { const parent = source(chatId); if (parent) chats.add(parent) }
  return chats
}
