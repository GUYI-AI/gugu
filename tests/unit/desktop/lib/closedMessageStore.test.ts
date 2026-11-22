// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange, IDBObjectStore as FakeStore } from 'fake-indexeddb'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { ImMessageBatch } from '../../../../apps/desktop/src/session/shared/core/im-messages'
import { createLocalMessageStore } from '../../../../apps/desktop/src/lib/localMessageStore'
import { initializeMessages, ingestMessages } from '../../../../apps/desktop/src/lib/messageIngest'
import { eraseClosedImAccount } from '../../../../apps/desktop/src/lib/imRepository'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { requestResult, transactionDone } from '../../../../apps/desktop/src/lib/indexedDbHandle'

const names = ['messages', 'ranges', 'tombstones', 'access', 'accounts']
const stores: ReturnType<typeof createLocalMessageStore>[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture() {
  const factory = new IDBFactory()
  vi.stubGlobal('indexedDB', factory); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const open = () => { const store = createLocalMessageStore({ indexedDb: factory }); stores.push(store); return store }
  return { factory, open, a: crypto.randomUUID(), b: crypto.randomUUID() }
}
function batch(owner: string, id: string): ImMessageBatch {
  const message = messageItemFromRow({ id, chat_id: 'room', seq: 1, sender_user_id: owner,
    content_type: 'text', content: 'private cached message', created_at: '2026-11-02T00:00:00Z' }, owner)!
  return { writes: [{ type: 'chatAccess', access: { chatId: 'room', ownMember: true } },
    { type: 'put', message }, { type: 'delete', chatId: 'room', id: 'absent' }], revisions: [],
    ranges: [{ chatId: 'room', fromSeq: 1, toSeq: 1 }], throughRevision: '7' }
}
async function snapshot(factory: IDBFactory, owner: string) {
  const db = await requestResult(factory.open('gugu.messages.v1'))
  try {
    const transaction = db.transaction([...names, 'retired_accounts'], 'readonly')
    const done = transactionDone(transaction)
    const rows = await Promise.all([...names, 'retired_accounts'].map(async name => [name,
      (await requestResult(transaction.objectStore(name).getAll()) as { accountId: string }[]).filter(row => row.accountId === owner)] as const))
    await done
    return Object.fromEntries(rows)
  } finally { db.close() }
}
const dataRows = (rows: Awaited<ReturnType<typeof snapshot>>) => names.flatMap(name => rows[name])

describe('trusted deletion of the separate phone message database', () => {
  it('upgrades the dev v1 message database without dropping its cached rows or cursor', async () => {
    const f = fixture(), opening = f.factory.open('gugu.messages.v1', 1)
    opening.onupgradeneeded = () => {
      const db = opening.result
      db.createObjectStore('messages', { keyPath: ['accountId', 'id'] }).createIndex('chat', ['accountId', 'chatId'])
      db.createObjectStore('ranges', { keyPath: ['accountId', 'chatId', 'root'] })
      db.createObjectStore('tombstones', { keyPath: ['accountId', 'chatId', 'messageId'] })
      db.createObjectStore('access', { keyPath: ['accountId', 'chatId'] })
      db.createObjectStore('accounts', { keyPath: 'accountId' })
      const put = batch(f.a, 'kept').writes.find(write => write.type === 'put')!
      if (put.type !== 'put') throw new Error('Missing message fixture')
      opening.transaction!.objectStore('messages').put({ accountId: f.a, id: 'kept', chatId: 'room', claimed: '7', message: put.message })
      opening.transaction!.objectStore('accounts').put({ accountId: f.a, through: '7' })
    }
    const previous = await requestResult(opening); previous.close()
    const store = f.open()
    expect(await store.throughRevision(f.a)).toBe('7')
    expect((await store.windows(f.a, ['room'], 10)).map(row => row.id)).toEqual(['kept'])
    expect((await snapshot(f.factory, f.a)).retired_accounts).toEqual([])
  })

  it('purges every A row, rejects cached/late/reopened A writes, and keeps B unchanged', async () => {
    const f = fixture(), first = f.open(), second = f.open()
    await first.ingest(f.a, batch(f.a, 'a')); await first.ingest(f.b, batch(f.b, 'b'))
    expect(await second.windows(f.a, ['room'], 10)).toHaveLength(1)
    const beforeB = await snapshot(f.factory, f.b)
    await first.retireAccount(f.a)
    expect(dataRows(await snapshot(f.factory, f.a))).toEqual([])
    expect((await snapshot(f.factory, f.a)).retired_accounts).toHaveLength(1)
    await expect(second.ingest(f.a, batch(f.a, 'late'))).rejects.toThrow('im_account_retired')
    await expect(second.windows(f.a, ['room'], 10)).rejects.toThrow('im_account_retired')
    await second.clearAccount(f.a)
    first.close(); second.close()
    const reopened = f.open()
    await expect(reopened.ingest(f.a, { writes: [], revisions: [], throughRevision: '999' })).rejects.toThrow('im_account_retired')
    await expect(reopened.ingest(f.a, batch(f.a, 'after-restart'))).rejects.toThrow('im_account_retired')
    expect(await snapshot(f.factory, f.b)).toEqual(beforeB)
    await reopened.ingest(f.b, batch(f.b, 'new-b'))
    expect((await reopened.windows(f.b, ['room'], 10)).map(row => row.id).sort()).toEqual(['b', 'new-b'])
    await reopened.retireAccount(f.a)
    expect(dataRows(await snapshot(f.factory, f.a))).toEqual([])
  })

  it('purges an already-dispatched write and refuses a write ordered after retirement', async () => {
    const f = fixture(), first = f.open(), second = f.open()
    await first.ingest(f.b, batch(f.b, 'b')); await second.windows(f.a, ['room'], 10)
    let entered!: () => void
    const writingRows = new Promise<void>(resolve => { entered = resolve })
    const original = FakeStore.prototype.put
    vi.spyOn(FakeStore.prototype, 'put').mockImplementation(function(this: InstanceType<typeof FakeStore>, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args)
      if (this.name === 'messages') entered()
      return result
    })
    const writing = second.ingest(f.a, batch(f.a, 'in-flight'))
    await writingRows
    await Promise.all([writing, first.retireAccount(f.a)])
    expect(dataRows(await snapshot(f.factory, f.a))).toEqual([])
    const retiring = first.retireAccount(f.b)
    const refused = expect(second.ingest(f.b, batch(f.b, 'late-b'))).rejects.toThrow('im_account_retired')
    await retiring; await refused
    expect(dataRows(await snapshot(f.factory, f.b))).toEqual([])
  })

  it('rolls back the retirement marker and all deletes together when cleanup fails', async () => {
    const f = fixture(), store = f.open()
    await store.ingest(f.a, batch(f.a, 'original'))
    const before = await snapshot(f.factory, f.a), original = FakeStore.prototype.delete
    const failure = vi.spyOn(FakeStore.prototype, 'delete').mockImplementation(function(this: InstanceType<typeof FakeStore>, ...args: Parameters<typeof original>) {
      if (this.name === 'access') throw new Error('Injected message cleanup failure')
      return original.apply(this, args)
    })
    await expect(store.retireAccount(f.a)).rejects.toThrow('Injected message cleanup failure')
    failure.mockRestore()
    expect(await snapshot(f.factory, f.a)).toEqual(before)
    await store.ingest(f.a, batch(f.a, 'still-normal'))
  })

  it('the existing trusted-deleted finalizer retires both databases before returning', async () => {
    const f = fixture(), otherWindow = f.open(), sync = await openLocalSyncDb(f.factory)
    try {
      initializeMessages(f.a); initializeMessages(f.b)
      await ingestMessages(f.a, batch(f.a, 'a')); await ingestMessages(f.b, batch(f.b, 'b'))
      await sync.commit([{ type: 'put', store: 'sync_state', value: { accountId: f.a, key: 'revision', value: { revision: '7' } } }])
      const beforeB = await snapshot(f.factory, f.b)
      await eraseClosedImAccount(f.a, sync)
      expect(dataRows(await snapshot(f.factory, f.a))).toEqual([])
      expect(Object.values(await sync.loadAccount(f.a)).flat()).toEqual([])
      await expect(otherWindow.ingest(f.a, batch(f.a, 'late'))).rejects.toThrow('im_account_retired')
      initializeMessages(f.a)
      await expect(ingestMessages(f.a, batch(f.a, 'reopened'))).rejects.toThrow('im_account_retired')
      expect(await snapshot(f.factory, f.b)).toEqual(beforeB)
    } finally { sync.close() }
  })

  it('ordinary logout clearing still permits the same owner to write after reopening', async () => {
    const f = fixture(), store = f.open()
    await store.ingest(f.a, batch(f.a, 'before')); await store.clearAccount(f.a)
    await store.ingest(f.a, batch(f.a, 'after'))
    expect((await store.windows(f.a, ['room'], 10)).map(row => row.id)).toEqual(['after'])
    expect((await snapshot(f.factory, f.a)).retired_accounts).toEqual([])
  })
})
