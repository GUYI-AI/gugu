import { createIndexedDbHandle } from './indexedDbHandle'

export const WIDGET_SNAPSHOT_EVENT = 'gugu:widget-snapshot'
export const WIDGET_SNAPSHOT_MAX_BYTES = 200 * 1024
export const WIDGET_SNAPSHOT_ACCOUNT_BYTES = 20 * 1024 * 1024
type Capture = { accountId: string; generation: number }
interface Snapshot { key: string; accountId: string; blob: Blob; usedAt: number }
export const widgetSnapshotKey = (accountId: string, widgetId: string, theme: string, width: number) => JSON.stringify([accountId, widgetId, theme, Math.floor(width / 40)])

/** Local pictures only: no spec, network storage or cross-account reuse. */
export class WidgetSnapshots {
  private accountId: string | null = null
  private generation = 0
  private tail: Promise<unknown> = Promise.resolve()
  private readonly handle

  constructor(indexedDb: () => IDBFactory = () => window.indexedDB) {
    this.handle = createIndexedDbHandle(() => new Promise((resolve: (db: IDBDatabase) => void, reject) => {
      const request = indexedDb().open('gugu.widgetSnapshots.v1', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('widgetSnapshots', { keyPath: 'key' }).createIndex('accountId', 'accountId')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new Error('Widget snapshot storage is blocked'))
    }))
  }

  capture(): Capture | null { return this.accountId ? { accountId: this.accountId, generation: this.generation } : null }
  private current(capture: Capture): boolean { return capture.accountId === this.accountId && capture.generation === this.generation }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }

  /** Only the signed-in account's pictures are kept: any other's go, also those left from an earlier run (null: all). */
  setAccount(accountId: string | null): Promise<void> {
    if (this.accountId === accountId) return Promise.resolve()
    this.accountId = accountId
    ++this.generation
    return this.queue(async () => {
      const db = await this.handle.get()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('widgetSnapshots', 'readwrite')
        const store = transaction.objectStore('widgetSnapshots')
        const request = store.index('accountId').openKeyCursor()
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor) return
          if (cursor.key !== accountId) store.delete(cursor.primaryKey)
          cursor.continue()
        }
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
    })
  }

  read(widgetId: string, theme: string, width: number): Promise<Blob | null> {
    const capture = this.capture()
    if (!capture) return Promise.resolve(null)
    return this.queue(async () => {
      if (!this.current(capture)) return null
      const db = await this.handle.get()
      const key = widgetSnapshotKey(capture.accountId, widgetId, theme, width)
      const row = await new Promise<Snapshot | null>((resolve, reject) => {
        const transaction = db.transaction('widgetSnapshots', 'readwrite')
        const store = transaction.objectStore('widgetSnapshots')
        const request = store.get(key)
        let row: Snapshot | null = null
        request.onsuccess = () => { row = request.result ?? null; if (row) store.put({ ...row, usedAt: Date.now() }) }
        transaction.oncomplete = () => resolve(row)
        transaction.onabort = () => reject(transaction.error)
      })
      return this.current(capture) ? row?.blob ?? null : null
    })
  }

  put(capture: Capture, widgetId: string, theme: string, width: number, blob: Blob): Promise<boolean> {
    if (blob.size > WIDGET_SNAPSHOT_MAX_BYTES || blob.type !== 'image/webp') return Promise.resolve(false)
    return this.queue(async () => {
      if (!this.current(capture)) return false
      const db = await this.handle.get()
      if (!this.current(capture)) return false
      const key = widgetSnapshotKey(capture.accountId, widgetId, theme, width)
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('widgetSnapshots', 'readwrite')
        const store = transaction.objectStore('widgetSnapshots')
        const request = store.index('accountId').getAll(capture.accountId)
        request.onsuccess = () => {
          const other = (request.result as Snapshot[]).filter(row => row.key !== key).sort((a, b) => a.usedAt - b.usedAt)
          let size = blob.size + other.reduce((sum, row) => sum + row.blob.size, 0)
          for (const row of other) {
            if (size <= WIDGET_SNAPSHOT_ACCOUNT_BYTES) break
            store.delete(row.key)
            size -= row.blob.size
          }
          store.put({ key, accountId: capture.accountId, blob, usedAt: Date.now() } satisfies Snapshot)
        }
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
      })
      if (!this.current(capture)) return false
      window.dispatchEvent(new CustomEvent(WIDGET_SNAPSHOT_EVENT, { detail: key }))
      return true
    })
  }
}

export const widgetSnapshots = new WidgetSnapshots()

/** PNG transport from Electron; one WebP encoder, capped at DPR 2 and 200 KiB. */
export async function widgetSnapshotWebP(dataUrl: string, width: number): Promise<Blob | null> {
  const image = await createImageBitmap(await (await fetch(dataUrl)).blob())
  try {
    for (const dpr of [...new Set([Math.min(devicePixelRatio, 2), 1])]) {
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(image.width, Math.max(1, Math.round(width * dpr)))
      canvas.height = Math.max(1, Math.round(image.height * canvas.width / image.width))
      const context = canvas.getContext('2d')
      if (!context) return null
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', 0.8))
      if (blob?.type === 'image/webp' && blob.size <= WIDGET_SNAPSHOT_MAX_BYTES) return blob
    }
    return null
  } finally { image.close() }
}
