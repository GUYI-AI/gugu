// @@@legacy-outboxes — writes an older build queued in its own stores move into the outbox once, then leave those stores.
// Delete this file once no build that writes them is in use. (The chat sends an older build kept in the IM cache move in
// the chat wiring: takeLegacyOutboxRecords.)

import type { SessionInput } from '../sessionInput'
import { outbox } from '.'
import { SESSION_INPUT, type SessionSend } from './kinds/sessionInput'
import { enqueueAssistantNotice } from './kinds/assistantNotice'

const SESSION_INPUT_DB = 'gugu.session-input-outbox.v1'
const NOTICE_PREFIX = 'gugu.assistant-panel.notices.v1:'

async function existingDatabase(name: string): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return null
  if (!(await indexedDB.databases()).some(db => db.name === name)) return null
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function importLegacyWrites(accountId: string): Promise<void> {
  await outbox().loaded()
  const db = await existingDatabase(SESSION_INPUT_DB)
  if (db) {
    try {
      const all = await new Promise<SessionInput[]>((resolve, reject) => {
        const request = db.transaction('inputs').objectStore('inputs').getAll()
        request.onsuccess = () => resolve(request.result as SessionInput[])
        request.onerror = () => reject(request.error)
      })
      const mine = all.filter(row => row.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt)
      for (const row of mine) {
        if (outbox().get(row.id)) continue
        const { id, accountId: _account, failure, admission, undelivered: _undelivered, ...send } = row
        await outbox().enqueue<SessionSend>(SESSION_INPUT, send, { id, hold: !!row.sendQueue })
        if (admission === 'rejected') await outbox().fail(id, { reason: 'rejected', message: failure?.code === 'send-failed' ? failure.message : 'rejected', code: 'send-failed' })
      }
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('inputs', 'readwrite')
        for (const row of mine) tx.objectStore('inputs').delete([accountId, row.id])
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      if (mine.length === all.length) { db.close(); indexedDB.deleteDatabase(SESSION_INPUT_DB) }
    } finally { db.close() }
  }
  const key = NOTICE_PREFIX + accountId
  const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  if (raw) {
    for (const entry of JSON.parse(raw) as { notice: Parameters<typeof enqueueAssistantNotice>[0]; assistantId?: string }[]) {
      if (!outbox().get(`assistant:${entry.notice.operationId}`)) await enqueueAssistantNotice(entry.notice, entry.assistantId)
    }
    localStorage.removeItem(key)
  }
}
