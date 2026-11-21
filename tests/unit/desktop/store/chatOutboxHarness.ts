// A real outbox (core) over in-memory storage with a fake account, and the chat facade on it.
import { createOutbox, type Outbox, type OutboxAccount, type OutboxItem, type OutboxStorage } from '../../../../apps/desktop/src/lib/outbox/core'
import { createChatOutbox, recordOf, type ChatOutboxDeps, type ChatSend } from '../../../../apps/desktop/src/store/chatOutbox'
import type { OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'

export const ACCOUNT = 'user-1'

type Memory = OutboxStorage & { rows: Map<string, OutboxItem>; failNextWrite?: Error; beforeWrite?: (puts: readonly OutboxItem[], removes: readonly string[]) => Promise<void> }

export function memoryStorage(): Memory {
  const rows = new Map<string, OutboxItem>()
  const storage: Memory = {
    rows,
    list: async (accountId) => [...rows.values()].filter((row) => row.accountId === accountId).map((row) => structuredClone(row)),
    write: async (accountId, puts, removes) => {
      if (storage.failNextWrite) { const error = storage.failNextWrite; storage.failNextWrite = undefined; throw error }
      await storage.beforeWrite?.(puts, removes)
      for (const item of puts) rows.set(`${accountId}/${item.id}`, structuredClone(item))
      for (const id of removes) rows.delete(`${accountId}/${id}`)
    },
  }
  return storage
}

export function fakeAccount(initial: string | null = ACCOUNT): OutboxAccount & { set(id: string | null): void } {
  let id = initial
  const listeners = new Set<(id: string | null) => void>()
  return {
    current: () => id,
    credential: () => id,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    set(next) { id = next; for (const listener of listeners) listener(next) },
  }
}

export function makeRecord(id: string, over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    clientMessageId: id,
    chatId: 'chat-1',
    senderUserId: ACCOUNT,
    payload: {
      content: `msg-${id}`, contentType: 'text', toUserIds: null,
      replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false,
    },
    state: 'pending',
    attempts: 0,
    lastError: null,
    enqueuedAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
    ...over,
  }
}

export type ChatHarness = ReturnType<typeof chatHarness>

export function chatHarness(deliver: ChatOutboxDeps['deliver'], extra: Partial<ChatOutboxDeps> = {}, options: { storage?: ReturnType<typeof memoryStorage>; account?: ReturnType<typeof fakeAccount>; box?: Outbox } = {}) {
  const storage = options.storage ?? memoryStorage()
  const account = options.account ?? fakeAccount()
  const box = options.box ?? createOutbox({ storage, account, online: () => () => {} })
  const events: string[] = []
  const outbox = createChatOutbox(box, {
    deliver,
    onState: (r) => events.push(`state:${r.clientMessageId}:${r.state}`),
    onSent: (r) => { events.push(`sent:${r.clientMessageId}`) },
    onDiscarded: (r) => { events.push(`discarded:${r.clientMessageId}`) },
    ...extra,
  })
  /** The durable row as the chat store reads it. */
  const row = (id: string, owner = ACCOUNT) => {
    const item = storage.rows.get(`${owner}/${id}`) as OutboxItem<ChatSend> | undefined
    return item && recordOf(item)
  }
  const records = () => [...storage.rows.values()].map((item) => recordOf(item as OutboxItem<ChatSend>))
  return { storage, account, box, events, outbox, row, records }
}

/** Microtasks plus already-due timers (fake timers must be on). */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
