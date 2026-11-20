import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch, ImMessagePage, ImMessagePageResult, ImMessageWrite, MessageStore } from '../session/shared/core/im-messages'
import { chatsOfBatch, messageStoreOperations, requireId, type ChatAccessRow, type MessageStoreAdapter, type SeqRange } from '../session/shared/core/im-message-store'
import { createIndexedDbHandle } from './indexedDbHandle'
import { requestResult, transactionDone } from './indexedDbHandle'

// @@@client-state-model - the phone's adapter of the one message storage contract (session/shared/core/im-message-store).
// The contract runs synchronously over this account's rows held in memory; each batch then commits to IndexedDB in one
// transaction before the call returns. A chat's rows are read from IndexedDB the first time anything touches that chat,
// so opening the account costs the same whether it has ten conversations or a thousand.

const DB_NAME = 'gugu.messages.v1'
const STORES = ['messages', 'ranges', 'tombstones', 'access', 'accounts'] as const
type StoreName = (typeof STORES)[number]
type MessageRecord = { accountId: string; id: string; chatId: string; claimed: string | null; message: MessageItem }
type RangeRecord = { accountId: string; chatId: string; root: string; ranges: SeqRange[] }
type TombstoneRecord = { accountId: string; chatId: string; messageId: string }
type AccessRecord = ChatAccessRow & { accountId: string }
type Operation = { store: StoreName; put: object } | { store: StoreName; delete: IDBValidKey | IDBKeyRange }

const accountRange = (accountId: string) => IDBKeyRange.bound([accountId], [accountId, []])
const chatRange = (accountId: string, chatId: string) => IDBKeyRange.bound([accountId, chatId], [accountId, chatId, []])

function openDatabase(indexedDb: IDBFactory): Promise<IDBDatabase> {
  const opening = indexedDb.open(DB_NAME, 1)
  opening.onupgradeneeded = () => {
    const db = opening.result
    db.createObjectStore('messages', { keyPath: ['accountId', 'id'] }).createIndex('chat', ['accountId', 'chatId'])
    db.createObjectStore('ranges', { keyPath: ['accountId', 'chatId', 'root'] })
    db.createObjectStore('tombstones', { keyPath: ['accountId', 'chatId', 'messageId'] })
    db.createObjectStore('access', { keyPath: ['accountId', 'chatId'] })
    db.createObjectStore('accounts', { keyPath: 'accountId' })
  }
  return requestResult(opening)
}

/** One account's rows in memory. `loaded` chats hold every stored row, range and tombstone of that chat. */
class AccountRows {
  readonly loaded = new Set<string>()
  readonly messages = new Map<string, MessageRecord>()
  readonly byChat = new Map<string, Set<string>>()
  readonly ranges = new Map<string, SeqRange[]>()
  readonly tombstones = new Map<string, Set<string>>()
  readonly access = new Map<string, ChatAccessRow>()
  readonly children = new Map<string, Set<string>>()
  through: string | null = null
  operations: Operation[] = []

  constructor(readonly accountId: string) {}

  link(row: ChatAccessRow, previous?: ChatAccessRow) {
    if (previous?.sourceChatId) this.children.get(previous.sourceChatId)?.delete(previous.chatId)
    if (row.sourceChatId) {
      const set = this.children.get(row.sourceChatId) ?? new Set<string>()
      set.add(row.chatId)
      this.children.set(row.sourceChatId, set)
    }
  }

  fill(chatId: string, messages: MessageRecord[], ranges: RangeRecord[], tombstones: TombstoneRecord[]) {
    if (this.loaded.has(chatId)) return
    this.loaded.add(chatId)
    const ids = new Set<string>()
    for (const record of messages) { this.messages.set(record.id, record); ids.add(record.id) }
    this.byChat.set(chatId, ids)
    for (const record of ranges) this.ranges.set(`${chatId}\u0000${record.root}`, record.ranges)
    this.tombstones.set(chatId, new Set(tombstones.map(record => record.messageId)))
  }

  private chat(chatId: string): Set<string> {
    // The batch preloads every chat it touches; anything else is a contract violation, not an empty chat.
    if (!this.loaded.has(chatId)) throw new Error('Local message chat was used before it was read')
    return this.byChat.get(chatId)!
  }

  adapter(): MessageStoreAdapter {
    const accountId = this.accountId
    const stream = (chatId: string, root: string | null) => [...this.chat(chatId)].map(id => this.messages.get(id)!.message)
      .filter(message => root ? message.thread_root_id === root || message.id === root : !message.thread_root_id)
    const record = (op: Operation) => { this.operations.push(op) }
    return {
      transaction: body => body(),
      row: id => {
        const found = this.messages.get(id)
        return found && { message: found.message, claimedRevision: found.claimed }
      },
      putRow: (message, claimed) => {
        const ids = this.chat(message.chat_id)
        const previous = this.messages.get(message.id)
        if (previous && previous.chatId !== message.chat_id) this.byChat.get(previous.chatId)?.delete(message.id)
        const value: MessageRecord = { accountId, id: message.id, chatId: message.chat_id, claimed, message }
        this.messages.set(message.id, value)
        ids.add(message.id)
        record({ store: 'messages', put: value })
        return message
      },
      deleteRows: (chatId, ids) => {
        const rows = this.chat(chatId)
        for (const id of ids ?? [...rows]) {
          if (!rows.delete(id)) continue
          this.messages.delete(id)
          record({ store: 'messages', delete: [accountId, id] })
        }
      },
      stream: (chatId, root, after, before, limit, newer) => stream(chatId, root)
        .filter(message => message.seq > after && message.seq < before)
        .sort((a, b) => newer ? a.seq - b.seq : b.seq - a.seq).slice(0, limit),
      latest: (chatIds, limit) => [...chatIds].sort().flatMap(chatId => stream(chatId, null)
        .sort((a, b) => a.seq - b.seq).slice(-limit)),
      rows: ids => ids.flatMap(id => this.messages.get(id)?.message ?? []),
      createdAt: chatId => [...this.chat(chatId)].map(id => ({ id, createdAt: this.messages.get(id)!.message.created_at })),
      ranges: (chatId, root) => { this.chat(chatId); return this.ranges.get(`${chatId}\u0000${root}`) ?? [] },
      setRanges: (chatId, root, ranges) => {
        this.chat(chatId)
        this.ranges.set(`${chatId}\u0000${root}`, [...ranges])
        record({ store: 'ranges', put: { accountId, chatId, root, ranges: [...ranges] } satisfies RangeRecord })
      },
      dropRanges: chatId => {
        this.chat(chatId)
        for (const key of [...this.ranges.keys()]) if (key.startsWith(`${chatId}\u0000`)) {
          this.ranges.delete(key)
          record({ store: 'ranges', delete: [accountId, chatId, key.slice(chatId.length + 1)] })
        }
      },
      tombstoned: (chatId, messageId) => {
        this.chat(chatId)
        const set = this.tombstones.get(chatId)!
        return set.has('') || set.has(messageId)
      },
      tombstone: (chatId, messageId) => {
        this.chat(chatId)
        this.tombstones.get(chatId)!.add(messageId)
        record({ store: 'tombstones', put: { accountId, chatId, messageId } satisfies TombstoneRecord })
      },
      clearDeparture: chatId => {
        this.chat(chatId)
        if (this.tombstones.get(chatId)!.delete('')) record({ store: 'tombstones', delete: [accountId, chatId, ''] })
      },
      access: chatId => this.access.get(chatId),
      putAccess: row => {
        this.link(row, this.access.get(row.chatId))
        this.access.set(row.chatId, row)
        record({ store: 'access', put: { ...row, accountId } satisfies AccessRecord })
      },
      accessChildren: sourceChatId => [...this.children.get(sourceChatId) ?? []].flatMap(id => this.access.get(id) ?? []),
      throughRevision: () => this.through,
      setThroughRevision: revision => {
        this.through = revision
        record({ store: 'accounts', put: { accountId, through: revision } })
      },
      clear: () => {
        // The wrapper drops this account's memory after the commit; the next use reads the emptied disk.
        for (const store of ['messages', 'ranges', 'tombstones', 'access'] as const) record({ store, delete: accountRange(accountId) })
        record({ store: 'accounts', delete: accountId })
      },
    }
  }
}

export function createLocalMessageStore({ indexedDb = globalThis.indexedDB }: { indexedDb?: IDBFactory } = {}): MessageStore & { close(): void } {
  const handle = createIndexedDbHandle(() => openDatabase(indexedDb))
  const accounts = new Map<string, Promise<AccountRows>>()
  const loads = new Map<string, Promise<void>>()

  function account(accountId: string): Promise<AccountRows> {
    requireId(accountId)
    let opened = accounts.get(accountId)
    if (!opened) {
      opened = (async () => {
        const db = await handle.get()
        const transaction = db.transaction(['access', 'accounts'], 'readonly')
        const [access, progress] = await Promise.all([
          requestResult(transaction.objectStore('access').getAll(accountRange(accountId))) as Promise<AccessRecord[]>,
          requestResult(transaction.objectStore('accounts').get(accountId)) as Promise<{ through: string } | undefined>,
        ])
        const rows = new AccountRows(accountId)
        for (const { accountId: _owner, ...row } of access) { rows.access.set(row.chatId, row); rows.link(row) }
        rows.through = progress?.through ?? null
        return rows
      })()
      accounts.set(accountId, opened)
      opened.catch(() => { if (accounts.get(accountId) === opened) accounts.delete(accountId) })
    }
    return opened
  }

  async function load(rows: AccountRows, chatIds: Iterable<string>): Promise<void> {
    await Promise.all([...chatIds].filter(chatId => !rows.loaded.has(chatId)).map(chatId => {
      const key = JSON.stringify([rows.accountId, chatId])
      let pending = loads.get(key)
      if (!pending) {
        pending = (async () => {
          const db = await handle.get()
          const transaction = db.transaction(['messages', 'ranges', 'tombstones'], 'readonly')
          const [messages, ranges, tombstones] = await Promise.all([
            requestResult(transaction.objectStore('messages').index('chat').getAll([rows.accountId, chatId])) as Promise<MessageRecord[]>,
            requestResult(transaction.objectStore('ranges').getAll(chatRange(rows.accountId, chatId))) as Promise<RangeRecord[]>,
            requestResult(transaction.objectStore('tombstones').getAll(chatRange(rows.accountId, chatId))) as Promise<TombstoneRecord[]>,
          ])
          rows.fill(chatId, messages, ranges, tombstones)
        })().finally(() => loads.delete(key))
        loads.set(key, pending)
      }
      return pending
    }))
  }

  /** Runs the contract in memory, then commits its writes in one IndexedDB transaction. Any failure drops the memory copy. */
  async function run<T>(accountId: string, chatIds: (rows: AccountRows) => Iterable<string>, body: (rows: AccountRows) => T): Promise<T> {
    const rows = await account(accountId)
    await load(rows, chatIds(rows))
    rows.operations = []
    try {
      const result = body(rows)
      const operations = rows.operations
      rows.operations = []
      if (operations.length) {
        const db = await handle.get()
        const transaction = db.transaction([...STORES], 'readwrite')
        for (const operation of operations) {
          const store = transaction.objectStore(operation.store)
          if ('put' in operation) store.put(operation.put)
          else store.delete(operation.delete)
        }
        await transactionDone(transaction)
      }
      return result
    } catch (error) {
      // Memory may hold half of a batch, or a batch IndexedDB refused: it is a cache of disk, so read disk again.
      if (accounts.get(accountId) !== undefined) accounts.delete(accountId)
      throw error
    }
  }

  const operations = (rows: AccountRows) => messageStoreOperations(rows.adapter())

  async function chatsOfIds(rows: AccountRows, ids: readonly string[]): Promise<string[]> {
    const db = await handle.get()
    const store = db.transaction('messages', 'readonly').objectStore('messages')
    const found = await Promise.all(ids.map(id => rows.messages.get(id) ?? requestResult(store.get([rows.accountId, id])) as Promise<MessageRecord | undefined>))
    return [...new Set(found.flatMap(record => record?.chatId ?? []))]
  }

  return {
    ingest: (accountId: string, batch: ImMessageBatch): Promise<ImMessageWrite[]> =>
      run(accountId, rows => chatsOfBatch(batch, chatId => [...rows.children.get(chatId) ?? []],
        chatId => rows.access.get(chatId)?.sourceChatId ?? null),
        rows => operations(rows).ingest(batch)),
    windows: (accountId: string, chatIds: string[], limit: number): Promise<MessageItem[]> =>
      run(accountId, () => chatIds, rows => operations(rows).windows(chatIds, limit)),
    async page(accountId: string, page: ImMessagePage): Promise<ImMessagePageResult> {
      const rows = await account(accountId)
      const chats = page.ids ? await chatsOfIds(rows, page.ids) : [page.chatId!]
      return run(accountId, () => chats, current => operations(current).page(page))
    },
    throughRevision: async (accountId: string) => (await account(accountId)).through,
    async clearAccount(accountId: string) {
      await run(accountId, () => [], rows => operations(rows).clear())
      accounts.delete(accountId)
    },
    close: () => handle.close(),
  }
}
