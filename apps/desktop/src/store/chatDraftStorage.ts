import { rendererLogger } from '../lib/log'
import type { DraftAttachment } from './chatContext'

// #2383 群聊 / 私聊的输入框草稿(文字 + 选中的 @ + 排队的附件)落在本机,按账号隔离:整页重载、重启后还在;发出或清空后删掉。
// 做法与任务会话的草稿一致(nativeOfflineDraft:localStorage,键里带账号)。附件是 File,存不进 localStorage:条目里只记
// 每个附件的 id 和名字,字节按同一个键存进 IndexedDB。粘贴的截图、压缩过的照片、网页端的文件都没有磁盘路径,所以存字节不存路径。
// 记着名字却读不回字节的附件,恢复时报给调用方「已不可用」,❌ 悄悄丢掉。
const log = rendererLogger('chat/draft-storage')
const prefix = (accountId: string) => `gugu.chat-draft:${accountId}/`

export type StoredDraftMention = { userId: string; displayName: string }
type StoredAttachment = { id: string; name: string }
type Entry = { text: string; mentions: StoredDraftMention[]; attachments: StoredAttachment[] }

function isMention(value: unknown): value is StoredDraftMention {
  return !!value && typeof (value as StoredDraftMention).userId === 'string' && typeof (value as StoredDraftMention).displayName === 'string'
}

function isAttachment(value: unknown): value is StoredAttachment {
  return !!value && typeof (value as StoredAttachment).id === 'string' && typeof (value as StoredAttachment).name === 'string'
}

function readEntry(key: string): Entry | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<Entry>
    const attachments = value.attachments ?? []
    if (typeof value.text === 'string' && Array.isArray(value.mentions) && value.mentions.every(isMention)
      && Array.isArray(attachments) && attachments.every(isAttachment)) return { text: value.text, mentions: value.mentions, attachments }
  } catch { /* reported below */ }
  log.error({ key }, 'stored chat draft is malformed; it is left in place and not restored')
  return null
}

/** This account's stored drafts, by chat id. No account (signed out / inactive) = nothing stored. */
export function readChatDrafts(accountId: string | null): { texts: Record<string, string>; mentions: Record<string, StoredDraftMention[]> } {
  const texts: Record<string, string> = {}, mentions: Record<string, StoredDraftMention[]> = {}
  if (!accountId) return { texts, mentions }
  const own = prefix(accountId)
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(own)) continue
    const entry = readEntry(key)
    if (!entry) continue
    // @ picks without words mean nothing to restore (the composer drops them too).
    if (!entry.text) continue
    const chatId = key.slice(own.length)
    texts[chatId] = entry.text
    if (entry.mentions.length) mentions[chatId] = entry.mentions
  }
  return { texts, mentions }
}

/** Write one field of a chat's stored draft; the entry goes once all are empty (a send or clear empties all). */
export function writeChatDraft(accountId: string | null, chatId: string, patch: Partial<Omit<Entry, 'attachments'>>): void {
  if (accountId) writeEntry(prefix(accountId) + chatId, patch)
}

function writeEntry(key: string, patch: Partial<Entry>): void {
  const next: Entry = { text: '', mentions: [], attachments: [], ...readEntry(key), ...patch }
  if (!next.text && !next.mentions.length && !next.attachments.length) localStorage.removeItem(key)
  else localStorage.setItem(key, JSON.stringify(next))
}

export function removeChatDraft(accountId: string | null, chatId: string): void {
  if (!accountId) return
  const key = prefix(accountId) + chatId
  const stored = readEntry(key)?.attachments ?? []
  localStorage.removeItem(key)
  if (stored.length) void deleteFiles(stored.map(({ id }) => `${key}/${id}`))
}

/** Replace a chat's stored attachments: names go into the entry now, new bytes into IndexedDB, dropped ones are deleted. */
export function writeChatDraftAttachments(accountId: string | null, chatId: string, attachments: DraftAttachment[]): void {
  if (!accountId) return
  const key = prefix(accountId) + chatId
  const before = new Set((readEntry(key)?.attachments ?? []).map(({ id }) => id))
  const now = new Set(attachments.map(({ id }) => id))
  writeEntry(key, { attachments: attachments.map(({ id, file }) => ({ id, name: file.name })) })
  const added = attachments.filter(({ id }) => !before.has(id))
  const dropped = [...before].filter(id => !now.has(id)).map(id => `${key}/${id}`)
  if (added.length) void putFiles(added.map(attachment => [`${key}/${attachment.id}`, attachment]))
  if (dropped.length) void deleteFiles(dropped)
}

/** This account's stored attachments by chat id, plus the names whose bytes could not be read back. */
export async function readChatDraftAttachments(accountId: string | null): Promise<{ attachments: Record<string, DraftAttachment[]>; unavailable: Record<string, string[]> }> {
  const attachments: Record<string, DraftAttachment[]> = {}, unavailable: Record<string, string[]> = {}
  if (!accountId) return { attachments, unavailable }
  const own = prefix(accountId)
  const listed: Array<[string, StoredAttachment[]]> = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    const stored = key?.startsWith(own) ? readEntry(key)?.attachments : undefined
    if (key && stored?.length) listed.push([key, stored])
  }
  if (!listed.length) return { attachments, unavailable }
  const files = await getFiles(listed.flatMap(([key, stored]) => stored.map(({ id }) => `${key}/${id}`)))
  for (const [key, stored] of listed) {
    const chatId = key.slice(own.length)
    for (const { id, name } of stored) {
      const file = files.get(`${key}/${id}`)
      if (file) (attachments[chatId] ??= []).push(file)
      else (unavailable[chatId] ??= []).push(name)
    }
  }
  return { attachments, unavailable }
}

const DB_NAME = 'gugu-chat-draft-files'
const STORE = 'file'

function openFiles(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open chat draft files failed'))
  })
}

async function inFiles<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => T): Promise<T> {
  const db = await openFiles()
  try {
    const tx = db.transaction(STORE, mode)
    const result = run(tx.objectStore(STORE))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('chat draft files transaction failed'))
    })
    return result
  } finally {
    db.close()
  }
}

function putFiles(rows: Array<[string, DraftAttachment]>): Promise<void> {
  return inFiles('readwrite', store => { for (const [key, attachment] of rows) store.put(attachment, key) })
    .catch(error => log.error({ count: rows.length, error: String(error) }, 'draft attachments not stored; they will show as unavailable after a restart'))
}

function deleteFiles(keys: string[]): Promise<void> {
  return inFiles('readwrite', store => { for (const key of keys) store.delete(key) })
    .catch(error => log.error({ count: keys.length, error: String(error) }, 'dropped draft attachments not deleted'))
}

async function getFiles(keys: string[]): Promise<Map<string, DraftAttachment>> {
  const found = new Map<string, DraftAttachment>()
  await inFiles('readonly', store => {
    for (const key of keys) {
      const request = store.get(key)
      request.onsuccess = () => { if (request.result) found.set(key, request.result as DraftAttachment) }
    }
  }).catch(error => log.error({ count: keys.length, error: String(error) }, 'draft attachments could not be read'))
  return found
}
