// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBIndex as FakeIndex, IDBKeyRange } from 'fake-indexeddb'
import { eraseClosedImAccount, openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb, openLocalSyncDb, IM_STORE_NAMES } from '../../../../apps/desktop/src/lib/localSyncDb'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function rawRows(factory: IDBFactory, owner: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('gugu.localSync.v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
  })
  try {
    const transaction = db.transaction(IM_STORE_NAMES, 'readonly')
    const done = new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error) })
    const values = await Promise.all(IM_STORE_NAMES.map(name => new Promise<unknown[]>((resolve, reject) => {
      const request = transaction.objectStore(name).index('accountId').getAll(owner)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })))
    await done; return values.flat()
  } finally { db.close() }
}
describe('closed original-owner renderer cache', () => {
  it('clears only A real IndexedDB ranges, rejects late A writes and preserves B byte for byte', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory(), adapter = await openLocalSyncDb(factory), a = crypto.randomUUID(), b = crypto.randomUUID()
    const first = await openImRepository(a, { adapter, initialize: async () => {} })
    const other = await openImRepository(b, { adapter, initialize: async () => {} })
    await first.transaction(tx => tx.putSyncState('original', { value: 'A' }))
    await other.transaction(tx => tx.putSyncState('original', { value: 'B' }))
    const beforeB = await adapter.loadAccount(b)
    localStorage.setItem('gugu.chatListCache.v2:' + a, 'A legacy')
    localStorage.setItem('gugu.chatListCache.v2:' + b, 'B legacy')
    await eraseClosedImAccount(a, adapter)
    expect(await rawRows(factory, a)).toEqual([])
    expect(localStorage.getItem('gugu.chatListCache.v2:' + a)).toBeNull()
    expect(localStorage.getItem('gugu.chatListCache.v2:' + b)).toBe('B legacy')
    expect(Object.values(await adapter.loadAccount(a)).flat()).toEqual([])
    expect(await adapter.loadAccount(b)).toEqual(beforeB)
    const second = await openLocalSyncDb(factory)
    await expect(second.commit([{ type: 'put', store: 'sync_state', value: { accountId: a, key: 'other-window', value: {} } }])).rejects.toThrow('retired')
    await second.commit([{ type: 'clearAccount', accountId: a }])
    await expect(second.commit([{ type: 'put', store: 'sync_state', value: { accountId: a, key: 'after-normal-clear', value: {} } }])).rejects.toThrow('retired')
    second.close()
    const reopened = await openLocalSyncDb(factory)
    await expect(reopened.commit([{ type: 'put', store: 'sync_state', value: { accountId: a, key: 'reopened', value: {} } }])).rejects.toThrow('retired')
    expect(await reopened.loadAccount(b)).toEqual(beforeB); reopened.close()
    expect(() => first.transaction(tx => tx.putSyncState('late', {}))).toThrow('closed')
    await expect(openImRepository(a, { adapter })).rejects.toThrow('Closed account')
    await other.transaction(tx => tx.putSyncState('still-active', {}))
    other.close(); adapter.close()
  })
  it('serializes retirement against a separate connection in both transaction orders', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory(), first = await openLocalSyncDb(factory), second = await openLocalSyncDb(factory)
    const a = crypto.randomUUID(), other = crypto.randomUUID()
    const startedFirst = second.commit([{ type: 'put', store: 'sync_state', value: { accountId: a, key: 'in-flight', value: {} } }])
    await Promise.all([startedFirst, first.retireAccount!(a)])
    expect(await rawRows(factory, a)).toEqual([])
    const retirement = first.retireAccount!(other)
    const late = second.commit([{ type: 'put', store: 'sync_state', value: { accountId: other, key: 'late', value: {} } }])
    const refused = expect(late).rejects.toThrow('retired')
    await retirement; await refused; expect(await rawRows(factory, other)).toEqual([])
    first.close(); second.close()
  })
  it('a clear failure rolls back both the persistent retirement mark and original rows', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const factory = new IDBFactory(), adapter = await openLocalSyncDb(factory), a = crypto.randomUUID()
    await adapter.commit([{ type: 'put', store: 'sync_state', value: { accountId: a, key: 'original', value: { keep: true } } }])
    // The clear walks each store's accountId index, so the fault goes on the index cursor.
    const before = await rawRows(factory, a), original = FakeIndex.prototype.openKeyCursor
    const failure = vi.spyOn(FakeIndex.prototype, 'openKeyCursor').mockImplementation(function(this: InstanceType<typeof FakeIndex>, ...args: Parameters<typeof original>) {
      if (this.objectStore.name === 'chat') throw new Error('Injected clear failure')
      return original.apply(this, args)
    })
    await expect(adapter.retireAccount!(a)).rejects.toThrow('Injected clear failure')
    failure.mockRestore()
    expect(await rawRows(factory, a)).toEqual(before)
    await expect(adapter.commit([{ type: 'put', store: 'sync_state', value: { accountId: a, key: 'not-retired', value: {} } }])).resolves.toBeUndefined()
    adapter.close()
  })
  it('waits for the original already-started commit before clearing, so its late completion cannot recreate A', async () => {
    const adapter = createMemoryLocalSyncDb(), a = crypto.randomUUID(), entered = deferred(), release = deferred()
    const repository = await openImRepository(a, { adapter, initialize: async () => {} })
    const writing = repository.transaction(async tx => { entered.resolve(); await release.promise; tx.putSyncState('late', {}) })
    await entered.promise
    let cleared = false
    const cleaning = eraseClosedImAccount(a, adapter).then(() => { cleared = true })
    await Promise.resolve(); expect(cleared).toBe(false)
    release.resolve(); await writing; await cleaning
    expect(Object.values(await adapter.loadAccount(a)).flat()).toEqual([])
  })
  it('fences an open that began before deletion, including asynchronous loading, before final clearing', async () => {
    const backing = createMemoryLocalSyncDb(), a = crypto.randomUUID(), entered = deferred(), release = deferred()
    const adapter = { ...backing, loadAccount: async (owner: string) => { entered.resolve(); await release.promise; return backing.loadAccount(owner) } }
    const opening = openImRepository(a, { adapter, initialize: async () => {} })
    const rejected = expect(opening).rejects.toThrow('Closed account')
    await entered.promise
    const cleaning = eraseClosedImAccount(a, backing)
    release.resolve(); await rejected; await cleaning
    expect(Object.values(await backing.loadAccount(a)).flat()).toEqual([])
  })
})
