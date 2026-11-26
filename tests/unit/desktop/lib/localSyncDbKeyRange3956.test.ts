// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { IM_STORE_NAMES, openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

// #3956: every account revision is a `view` row written, then deleted once acknowledged. Chromium keeps each deleted
// row's `accountId` index entry, and the readonly startup read walked all of them (1.3M on one install, ~6.7 s).
// Reads and clears go by the account's primary-key range instead and never touch a secondary index.
const keys = (rows: Record<string, Array<{ accountId: string; key?: string }>>) =>
  Object.fromEntries(Object.entries(rows).map(([store, values]) => [store, values.map((row) => `${row.accountId}/${row.key ?? ''}`)]))

async function seeded() {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  const adapter = await openLocalSyncDb(new IDBFactory())
  // 'account-a' is a prefix of 'account-ab': the key range must still keep them apart.
  await adapter.commit(['account-a', 'account-ab'].flatMap((accountId) => [
    { type: 'put' as const, store: 'sync_state' as const, value: { accountId, key: 'cursor', value: { revision: '1' } } },
    { type: 'put' as const, store: 'view' as const, value: { accountId, key: 'live', value: {} } },
    { type: 'put' as const, store: 'membership' as const, value: { accountId, chatId: 'chat-1', identityId: 'user-1', value: { role: 'member' } } },
  ]))
  // What the revision coordinator does for every revision: write an operation row, delete it once acknowledged.
  for (let revision = 0; revision < 50; revision += 1) {
    await adapter.commit([{ type: 'put', store: 'view', value: { accountId: 'account-a', key: `account-revision-operation:${revision}`, value: {} } }])
    await adapter.commit([{ type: 'delete', store: 'view', key: ['account-a', `account-revision-operation:${revision}`] }])
  }
  return adapter
}

describe('local IM cache reads and clears by account key range (#3956)', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('loads, clears and retires without opening any secondary index', async () => {
    const adapter = await seeded()
    const index = vi.spyOn(FakeObjectStore.prototype, 'index')
    expect(keys(await adapter.loadAccount('account-a'))).toMatchObject({
      view: ['account-a/live'], sync_state: ['account-a/cursor'], membership: ['account-a/'],
    })
    await adapter.commit([{ type: 'clearAccount', accountId: 'account-a' }])
    await adapter.retireAccount!('account-ab')
    expect(index).not.toHaveBeenCalled()
    adapter.close()
  })

  it('every store a clear touches is keyed by accountId first, so the key range holds all of an account', async () => {
    // A store added later whose primary key does not start with accountId would keep its rows through a clear or a
    // retirement (and never load them). This reads the real schema, so such a store fails here.
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory()
    ;(await openLocalSyncDb(factory)).close()
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('gugu.localSync.v2')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const stores = [...db.objectStoreNames].filter((name) => name !== 'retired_accounts' && name !== 'migration')
    expect(stores.sort()).toEqual([...IM_STORE_NAMES].sort())
    const write = db.transaction(stores, 'readwrite')
    for (const name of stores) {
      const keyPath = write.objectStore(name).keyPath
      expect(Array.isArray(keyPath) ? keyPath[0] : keyPath, `${name} keyPath`).toBe('accountId')
      for (const accountId of ['account-a', 'account-ab']) {
        write.objectStore(name).put({ ...Object.fromEntries([keyPath].flat().map((part) => [part, `${part}-1`])), accountId, value: {} })
      }
    }
    await new Promise((resolve, reject) => { write.oncomplete = resolve; write.onabort = () => reject(write.error) })
    db.close()
    const adapter = await openLocalSyncDb(factory)
    await adapter.commit([{ type: 'clearAccount', accountId: 'account-a' }])
    adapter.close()
    const after = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('gugu.localSync.v2')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const read = after.transaction(stores, 'readonly')
    const owners = await Promise.all(stores.map((name) => new Promise<string[]>((resolve, reject) => {
      const request = read.objectStore(name).getAll()
      request.onsuccess = () => resolve((request.result as Array<{ accountId: string }>).map((row) => row.accountId)); request.onerror = () => reject(request.error)
    })))
    after.close()
    expect(Object.fromEntries(stores.map((name, n) => [name, owners[n]]))).toEqual(Object.fromEntries(stores.map((name) => [name, ['account-ab']])))
  })

  it('keeps an account whose id the cleared one prefixes, and lands the clear before the put queued after it', async () => {
    const adapter = await seeded()
    const other = await adapter.loadAccount('account-ab')
    expect(keys(other)).toMatchObject({ view: ['account-ab/live'], sync_state: ['account-ab/cursor'] })
    await adapter.commit([
      { type: 'clearAccount', accountId: 'account-a' },
      { type: 'put', store: 'view', value: { accountId: 'account-a', key: 'after-clear', value: {} } },
    ])
    expect(keys(await adapter.loadAccount('account-a'))).toMatchObject({ view: ['account-a/after-clear'], sync_state: [], membership: [] })
    expect(await adapter.loadAccount('account-ab')).toEqual(other)
    await adapter.retireAccount!('account-a')
    expect(Object.values(await adapter.loadAccount('account-a')).flat()).toEqual([])
    expect(await adapter.loadAccount('account-ab')).toEqual(other)
    adapter.close()
  })
})
