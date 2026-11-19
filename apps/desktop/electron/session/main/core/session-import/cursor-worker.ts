import { scanCursorHistory, importCursorHistoryBatch } from '../../../../external-import/cursor'
import type { CursorRequest, CursorResponse } from '../../../../external-import/cursor-process'
import { ExternalHistoryStore } from '../../../../external-import/store'

process.once('disconnect', () => process.exit(0))
process.once('message', (request: CursorRequest) => {
  void (async (): Promise<CursorResponse> => {
    const signal = new AbortController().signal
    if (request.action === 'scan') return { action: 'scan', result: await scanCursorHistory(signal) }
    const store = new ExternalHistoryStore(request.directory)
    try {
      return { action: 'import', result: await importCursorHistoryBatch(request, store, signal) }
    } finally { store.close() }
  })().then(
    result => process.send?.(result, () => process.disconnect()),
    () => process.send?.({ error: 'Cursor history could not be read' }, () => process.disconnect()),
  )
})
