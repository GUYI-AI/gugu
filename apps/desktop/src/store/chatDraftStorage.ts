import { rendererLogger } from '../lib/log'

// #2383 群聊 / 私聊的输入框草稿(文字 + 选中的 @)落在本机,按账号隔离:整页重载、重启后还在;发出或清空后删掉。
// 做法与任务会话的草稿一致(nativeOfflineDraft:localStorage,键里带账号)。排队的附件是 File,存不进 localStorage,
// 只在内存里跟着会话切换走(#1872),重载后不在。
const log = rendererLogger('chat/draft-storage')
const prefix = (accountId: string) => `gugu.chat-draft:${accountId}/`

export type StoredDraftMention = { userId: string; displayName: string }
type Entry = { text: string; mentions: StoredDraftMention[] }

function isMention(value: unknown): value is StoredDraftMention {
  return !!value && typeof (value as StoredDraftMention).userId === 'string' && typeof (value as StoredDraftMention).displayName === 'string'
}

function readEntry(key: string): Entry | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as Partial<Entry>
    if (typeof value.text === 'string' && Array.isArray(value.mentions) && value.mentions.every(isMention)) return { text: value.text, mentions: value.mentions }
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

/** Write one field of a chat's stored draft; the entry goes once both are empty (a send or clear empties both). */
export function writeChatDraft(accountId: string | null, chatId: string, patch: Partial<Entry>): void {
  if (!accountId) return
  const key = prefix(accountId) + chatId
  const next = { text: '', mentions: [] as StoredDraftMention[], ...readEntry(key), ...patch }
  if (!next.text && !next.mentions.length) localStorage.removeItem(key)
  else localStorage.setItem(key, JSON.stringify(next))
}

export function removeChatDraft(accountId: string | null, chatId: string): void {
  if (accountId) localStorage.removeItem(prefix(accountId) + chatId)
}
