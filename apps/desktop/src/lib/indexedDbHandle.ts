/** Own a reusable handle, including the browser's unexpected-close lifecycle. */
export function createIndexedDbHandle(open: () => Promise<IDBDatabase>) {
  let current: IDBDatabase | null = null
  let opening: Promise<IDBDatabase> | null = null
  let disposed = false
  const disposedError = new Error('IndexedDB handle was closed by its owner')

  return {
    get(): Promise<IDBDatabase> {
      if (disposed) return Promise.reject(disposedError)
      if (current) return Promise.resolve(current)
      if (!opening) {
        const attempt = open().then(db => {
          if (disposed) { db.close(); throw disposedError }
          current = db
          // A forced close (e.g. browser storage I/O failure) does not make a saved
          // IDBDatabase usable again. Only the next operation opens a new handle;
          // the interrupted operation keeps its original failure and is not replayed.
          db.addEventListener('close', () => { if (current === db) current = null }, { once: true })
          return db
        })
        opening = attempt
        const settled = () => { if (opening === attempt) opening = null }
        void attempt.then(settled, settled)
      }
      return opening
    },
    close() {
      disposed = true
      current?.close()
      current = null
    },
  }
}

export type IndexedDbHandle = ReturnType<typeof createIndexedDbHandle>

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    request.onsuccess = () => resolve(request.result)
  })
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}
