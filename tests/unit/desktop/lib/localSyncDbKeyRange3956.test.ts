// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

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
