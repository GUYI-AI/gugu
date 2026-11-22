import { createIndexedDbHandle } from '../indexedDbHandle'
import type { OutboxItem, OutboxStorage } from './core'

/**
 * Its own database: rebuilding the message cache or taking a cold snapshot never touches unsent writes.
 */
export function openOutboxStorage(factory: IDBFactory = indexedDB): OutboxStorage {
  const handle = createIndexedDbHandle(() => new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('gugu.outbox.v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('items', { keyPath: ['accountId', 'id'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))
  return {
    async list(accountId) {
      const db = await handle.get()
      return new Promise<OutboxItem[]>((resolve, reject) => {
        const request = db.transaction('items').objectStore('items').getAll(IDBKeyRange.bound([accountId, ''], [accountId, '￿']))
        request.onsuccess = () => resolve(request.result as OutboxItem[])
        request.onerror = () => reject(request.error)
      })
    },
    async write(accountId, puts, removes) {
      const db = await handle.get()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('items', 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error ?? new Error('Outbox write aborted'))
        tx.onerror = () => reject(tx.error)
        const store = tx.objectStore('items')
        for (const item of puts) {
          if (item.accountId !== accountId) throw new Error(`outbox row ${item.id} belongs to another account`)
          store.put(item)
        }
        for (const id of removes) store.delete([accountId, id])
      })
    },
  }
}
