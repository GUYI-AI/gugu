import { rendererLogger } from '../lib/log'
import { clearViewState, readPanelEntries, readViewState, writeViewState, type ViewPanel } from '../lib/viewStateTable'

// #2383 群聊 / 私聊的输入框草稿(文字 + 选中的 @)落在本机,按账号隔离:整页重载、重启后还在;发出或清空后删掉。
// 存在视图状态表里(lib/viewStateTable,面板 `draft`,条数和大小有上限,见 view-state-models.ts),首帧就在。
// 排队的附件是 File,存不进去,只在内存里跟着会话切换走(#1872),重载后不在。
const log = rendererLogger('chat/draft-storage')

export type StoredDraftMention = { userId: string; displayName: string }
type Entry = { text: string; mentions: StoredDraftMention[] }
const draftOf = (accountId: string, chatId: string): ViewPanel => ({ conversation: chatId, panel: 'draft', account: accountId })

function isMention(value: unknown): value is StoredDraftMention {
  return !!value && typeof (value as StoredDraftMention).userId === 'string' && typeof (value as StoredDraftMention).displayName === 'string'
}

// Drafts kept in localStorage before the table (`gugu.chat-draft:<account>/<chat>`): moved over once, when this module loads
// (before anything renders), then removed there.
const LEGACY_PREFIX = 'gugu.chat-draft:'
if (typeof localStorage !== 'undefined') {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(LEGACY_PREFIX))
  const moved: string[] = []
  for (const key of keys) {
    const [accountId, ...chat] = key.slice(LEGACY_PREFIX.length).split('/')
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '') as Partial<Entry>
      if (!accountId || !chat.length || typeof value.text !== 'string' || !Array.isArray(value.mentions) || !value.mentions.every(isMention)) throw new Error('malformed')
      const draft = draftOf(accountId, chat.join('/'))
      if (value.text && !readViewState<Entry>(draft).text) writeViewState<Entry>(draft, { text: value.text, mentions: value.mentions })
      moved.push(key)
    } catch {
      log.error({ key }, 'stored chat draft is malformed; it is left in place and not restored')
    }
  }
  // Once all are in, every old key goes: the table holds what its caps allow (beyond 32 drafts or 96 KB the oldest drop,
  // as for any draft). Keeping the rest would only move them in again next start and push out others.
  for (const key of moved) localStorage.removeItem(key)
}

/** This account's stored drafts, by chat id. No account (signed out / inactive) = nothing stored. */
export function readChatDrafts(accountId: string | null): { texts: Record<string, string>; mentions: Record<string, StoredDraftMention[]> } {
  const texts: Record<string, string> = {}, mentions: Record<string, StoredDraftMention[]> = {}
  if (!accountId) return { texts, mentions }
  for (const [chatId, entry] of readPanelEntries<Entry>('draft', accountId)) {
    // @ picks without words mean nothing to restore (the composer drops them too). Drafts of a task (`task:…`) or of the
    // account itself (`account:…`) are not a chat's.
    if (!entry.text || chatId.includes(':')) continue
    texts[chatId] = entry.text
    if (entry.mentions?.length) mentions[chatId] = entry.mentions
  }
  return { texts, mentions }
}

/** Write one field of a chat's stored draft; the entry goes once both are empty (a send or clear empties both). */
export function writeChatDraft(accountId: string | null, chatId: string, patch: Partial<Entry>): void {
  if (!accountId) return
  const draft = draftOf(accountId, chatId)
  const stored = readViewState<Entry>(draft)
  const next = { text: '', mentions: [] as StoredDraftMention[], ...stored, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) }
  if (!next.text && !next.mentions.length) clearViewState(draft)
  else if (JSON.stringify(next) !== JSON.stringify({ text: '', mentions: [], ...stored })) writeViewState<Entry>(draft, next)
}
