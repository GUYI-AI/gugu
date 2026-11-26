// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

// #3967: the cache moves from `gugu.localSync.v1` (indexes full of dead entries, #3956) into the index-free
// `gugu.localSync.v2`. The old database is the source of truth until the copy reads back identical; only then is it
// deleted. Every step must survive the process dying in the middle of it.
const LEGACY = 'gugu.localSync.v1', CURRENT = 'gugu.localSync.v2'
const KEY_PATHS: Record<string, string[]> = {
  identity: ['accountId', 'id'], chat: ['accountId', 'id'], membership: ['accountId', 'chatId', 'identityId'],
  presence: ['accountId', 'identityId'], outbox: ['accountId', 'id'], view: ['accountId', 'key'], sync_state: ['accountId', 'key'],
}
const OUTBOX = {
  clientMessageId: 'unsent-1', chatId: 'chat-1', senderUserId: 'account-a', state: 'failed', attempts: 2, lastError: 'offline',
  enqueuedAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:01.000Z',
  payload: { content: 'do not lose me', contentType: 'text', toUserIds: null, replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false },
}

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) })
const done = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
const names = async (factory: IDBFactory) => (await factory.databases()).map((entry) => entry.name).sort()

/** A published v6 database: indexes, two accounts, an unsent message, a retired owner, churned revision rows. */
async function seedLegacy(factory: IDBFactory): Promise<void> {
  const opening = factory.open(LEGACY, 6)
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('retired_accounts', { keyPath: 'accountId' })
    for (const [name, keyPath] of Object.entries(KEY_PATHS)) {
      const store = opening.result.createObjectStore(name, { keyPath })
      store.createIndex('accountId', 'accountId')
      if (name === 'membership') store.createIndex('accountChat', ['accountId', 'chatId'])
    }
  }
  const db = await request(opening)
  const write = db.transaction([...Object.keys(KEY_PATHS), 'retired_accounts'], 'readwrite')
  for (const accountId of ['account-a', 'account-b']) {
    write.objectStore('sync_state').put({ accountId, key: 'account-revision-cursor', value: { revision: '42' } })
    write.objectStore('membership').put({ accountId, chatId: 'chat-1', identityId: 'user-1', value: { role: 'member' } })
  }
  write.objectStore('outbox').put({ accountId: 'account-a', id: 'unsent-1', value: OUTBOX })
  write.objectStore('retired_accounts').put({ accountId: 'account-closed', protocolVersion: 2 })
  for (let revision = 0; revision < 100; revision += 1) {
    write.objectStore('view').put({ accountId: 'account-a', key: `account-revision-operation:${revision}`, value: {} })
    write.objectStore('view').delete(['account-a', `account-revision-operation:${revision}`])
  }
  await done(write)
  db.close()
}

async function migrationState(factory: IDBFactory): Promise<unknown> {
  const db = await request(factory.open(CURRENT))
  try { return await request(db.transaction('migration', 'readonly').objectStore('migration').get('legacy')) } finally { db.close() }
}

async function expectCopied(factory: IDBFactory) {
  const adapter = await openLocalSyncDb(factory)
  const a = await adapter.loadAccount('account-a'), b = await adapter.loadAccount('account-b')
  expect(a.outbox.map((row) => row.value)).toEqual([OUTBOX])
  expect(a.sync_state).toEqual([{ accountId: 'account-a', key: 'account-revision-cursor', value: { revision: '42' } }])
  expect(b.membership).toHaveLength(1)
  expect(a.view).toEqual([])
  await expect(adapter.commit([{ type: 'put', store: 'sync_state', value: { accountId: 'account-closed', key: 'late', value: {} } }])).rejects.toThrow('retired')
  adapter.close()
}

describe('local IM cache moves into an index-free database (#3967)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('copies every row, verifies it, then deletes the legacy database', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    await seedLegacy(factory)
    await expectCopied(factory)
    expect(await names(factory)).toEqual([CURRENT])
    expect(await migrationState(factory)).toEqual({ key: 'legacy', state: 'done' })
    const db = await request(factory.open(CURRENT))
    const transaction = db.transaction([...db.objectStoreNames], 'readonly')
    expect([...db.objectStoreNames].flatMap((name) => [...transaction.objectStore(name).indexNames])).toEqual([])
    db.close()
    await expectCopied(factory) // a second start is a plain open
  })

  it('a process killed while writing the copy leaves no new database and the legacy one untouched', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    await seedLegacy(factory)
    const put = FakeObjectStore.prototype.put
    vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: InstanceType<typeof FakeObjectStore>, ...args: Parameters<typeof put>) {
      if (this.name === 'outbox' && this.transaction.mode === 'versionchange') throw new Error('killed mid-copy')
      return put.apply(this, args)
    })
    await expect(openLocalSyncDb(factory)).rejects.toThrow()
    vi.restoreAllMocks()
    expect(await names(factory)).toEqual([LEGACY])
    await expectCopied(factory) // the next start copies again
    expect(await names(factory)).toEqual([CURRENT])
  })

  it('a process killed after the copy but before verifying it verifies at the next start', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    await seedLegacy(factory)
    const put = FakeObjectStore.prototype.put
    vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: InstanceType<typeof FakeObjectStore>, ...args: Parameters<typeof put>) {
      if (this.name === 'migration' && (args[0] as { state?: string }).state === 'verified') throw new Error('killed before verifying')
      return put.apply(this, args)
    })
    await expect(openLocalSyncDb(factory)).rejects.toThrow('killed before verifying')
    vi.restoreAllMocks()
    expect(await names(factory)).toEqual([LEGACY, CURRENT])
    expect(await migrationState(factory)).toEqual({ key: 'legacy', state: 'copied' })
    await expectCopied(factory)
    expect(await names(factory)).toEqual([CURRENT])
    expect(await migrationState(factory)).toEqual({ key: 'legacy', state: 'done' })
  })

  it('a copy that does not read back identical is dropped and the legacy database keeps serving', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    await seedLegacy(factory)
    // An interrupted earlier start left a copy that lost the unsent message.
    const opening = factory.open(CURRENT, 1)
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('retired_accounts', { keyPath: 'accountId' })
      opening.result.createObjectStore('migration', { keyPath: 'key' }).put({ key: 'legacy', state: 'copied' })
      for (const [name, keyPath] of Object.entries(KEY_PATHS)) opening.result.createObjectStore(name, { keyPath })
    }
    ;(await request(opening)).close()
    await expectCopied(factory)
    expect(await names(factory)).toEqual([LEGACY])
  })

  it('a blocked legacy delete keeps the verified copy and finishes at a later start', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    await seedLegacy(factory)
    const holder = await request(factory.open(LEGACY)) // e.g. a window still on an older build
    const adapter = await openLocalSyncDb(factory)
    expect((await adapter.loadAccount('account-a')).outbox).toHaveLength(1)
    adapter.close()
    expect(await migrationState(factory)).toEqual({ key: 'legacy', state: 'verified' })
    holder.close()
    await new Promise((resolve) => setTimeout(resolve, 0)) // the queued delete runs once the holder closed
    await expectCopied(factory)
    expect(await names(factory)).toEqual([CURRENT])
    expect(await migrationState(factory)).toEqual({ key: 'legacy', state: 'done' })
  })

  it('a fresh install creates only the current database', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    const adapter = await openLocalSyncDb(factory)
    await adapter.commit([{ type: 'put', store: 'sync_state', value: { accountId: 'account-a', key: 'k', value: {} } }])
    expect((await adapter.loadAccount('account-a')).sync_state).toHaveLength(1)
    adapter.close()
    expect(await names(factory)).toEqual([CURRENT])
  })
})
