import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { expect, it } from 'vitest'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

// v4 → v5: messages moved to the message store (lib/localMessageStore). The old message cache leaves; nothing else does.
it('drops the v4 message tables and message view rows, keeping every other row of every account', async () => {
  const factory = new IDBFactory()
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('gugu.localSync.v1', 4)
    request.onupgradeneeded = () => {
      const db = request.result
      const keys: Record<string, string[]> = { identity: ['accountId', 'id'], chat: ['accountId', 'id'], membership: ['accountId', 'chatId', 'identityId'],
        message: ['accountId', 'id'], stream: ['accountId', 'id'], presence: ['accountId', 'identityId'], outbox: ['accountId', 'id'],
        view: ['accountId', 'key'], sync_state: ['accountId', 'key'] }
      for (const [name, keyPath] of Object.entries(keys)) db.createObjectStore(name, { keyPath }).createIndex('accountId', 'accountId')
      const tx = request.transaction!
      for (const accountId of ['desktop', 'phone']) {
        tx.objectStore('message').put({ accountId, id: 'old', chatId: 'chat', streamId: 'main:chat', seq: 1, value: {} })
        tx.objectStore('stream').put({ accountId, id: 'main:chat', chatId: 'chat', kind: 'main', rootMessageId: null })
        for (const key of ['message-window:chat', 'message-revision:old', 'history-cleared:chat', 'account-revision-operation:1']) {
          tx.objectStore('view').put({ accountId, key, value: { revision: '1', event: 'presence_changed', payload: {} } })
        }
        tx.objectStore('sync_state').put({ accountId, key: 'account-revision-cursor', value: { revision: '7' } })
      }
    }
    request.onsuccess = () => { request.result.close(); resolve() }
    request.onerror = () => reject(request.error)
  })
  const adapter = await openLocalSyncDb(factory)
  try {
    for (const accountId of ['desktop', 'phone']) {
      const rows = await adapter.loadAccount(accountId)
      expect(Object.keys(rows)).not.toContain('message')
      expect(rows.view.map(row => row.key)).toEqual(['account-revision-operation:1'])
      expect(rows.sync_state.map(row => row.value)).toEqual([{ revision: '7' }])
    }
  } finally { adapter.close() }
})

it('upgrades formal dev v5 to v6 by adding retirement without changing existing rows', async () => {
  const factory = new IDBFactory(), opening = factory.open('gugu.localSync.v1', 5)
  opening.onupgradeneeded = () => {
    const keys: Record<string, string[]> = { identity: ['accountId', 'id'], chat: ['accountId', 'id'], membership: ['accountId', 'chatId', 'identityId'],
      presence: ['accountId', 'identityId'], outbox: ['accountId', 'id'], view: ['accountId', 'key'], sync_state: ['accountId', 'key'] }
    for (const [name, keyPath] of Object.entries(keys)) {
      const store = opening.result.createObjectStore(name, { keyPath }); store.createIndex('accountId', 'accountId')
      if (name === 'membership') store.createIndex('accountChat', ['accountId', 'chatId'])
    }
    opening.transaction!.objectStore('sync_state').put({ accountId: 'owner', key: 'account-revision-cursor', value: { revision: '7' } })
  }
  await new Promise<void>((resolve, reject) => { opening.onsuccess = () => { opening.result.close(); resolve() }; opening.onerror = () => reject(opening.error) })
  const adapter = await openLocalSyncDb(factory)
  try {
    expect((await adapter.loadAccount('owner')).sync_state).toEqual([{ accountId: 'owner', key: 'account-revision-cursor', value: { revision: '7' } }])
    await adapter.retireAccount!('owner')
    await expect(adapter.commit([{ type: 'put', store: 'sync_state', value: { accountId: 'owner', key: 'late', value: {} } }])).rejects.toThrow('retired')
  } finally { adapter.close() }
})
