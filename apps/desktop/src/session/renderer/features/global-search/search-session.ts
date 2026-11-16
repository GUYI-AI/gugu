import { useSyncExternalStore } from 'react'
import { commandRegistry } from '@renderer/lib/commands/registry'
import { clearViewState, readViewState, takeLegacyLocalStorageForAccount, writeViewState, type ViewPanel } from '@/lib/viewStateTable'

/** What a message is, for the quick filters: a picture or video, any other file, a link, or one that @-mentions me. */
export type SearchKind = 'media' | 'file' | 'link' | 'mention'

/** A scope that narrows the search: one conversation, one local task, one sender, or one kind of message. */
export type SearchChip =
  | { kind: 'in'; chatId: string }
  | { kind: 'in-task'; taskId: string; title: string }
  | { kind: 'from'; userId: string; name: string }
  | { kind: 'type'; type: SearchKind }

/** The message hits a search opened from, in the panel's order: the bar over the chat steps through them (1/N, ⌘G). */
export interface SearchTrail {
  hits: { chatId: string; messageId: string }[]
  index: number
  /** The searched words, painted on the message the trail lands on. */
  query: string
}

/** The filter row: everything, chat messages, task content, or files sent in chats. */
export type SearchFacet = 'all' | 'message' | 'task' | 'file'

export interface SearchSession {
  text: string
  chips: SearchChip[]
  facet: SearchFacet
  /** The highlighted result (null: the first one). */
  selectedId: string | null
  /** Set when a message hit was opened; kept while the panel is reopened with 「结果」, dropped by a new search. */
  trail: SearchTrail | null
}

const EMPTY: SearchSession = { text: '', chips: [], facet: 'all', selectedId: null, trail: null }
let session = EMPTY
const listeners = new Set<() => void>()

export function updateSearchSession(change: Partial<SearchSession>): void {
  session = { ...session, ...change }
  for (const listener of listeners) listener()
}

export function useSearchSession(): SearchSession {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => session)
}

/** Start a fresh search with this text and scope, without opening anything. */
export function resetSearchSession(options: { text?: string; chips?: SearchChip[] } = {}): void {
  updateSearchSession({ ...EMPTY, text: options.text ?? '', chips: options.chips ?? [] })
}

/**
 * Every entry point opens this one panel: the sidebar box, Mod+Shift+F, the quick switcher's last row, and every search
 * inside a conversation (⌘F, the header's and settings' 「搜索聊天记录」, a member's 「查找 TA 的消息」), which come
 * scoped with an in: chip the user can remove. The panel's host answers app.globalSearch: the task workspace's modal,
 * or the sheet on the phone shell and wherever there is no workspace.
 */
export function openGlobalSearch(options: { text?: string; chips?: SearchChip[] } = {}): void {
  resetSearchSession(options)
  if (!commandRegistry.dispatch('app.globalSearch')) throw new Error('No global search panel is mounted')
}

/** 「结果」 on the trail bar, and Mod+Shift+F: the panel as it was left, query, scope and selection kept. */
export function reopenGlobalSearch(): void {
  if (!commandRegistry.dispatch('app.globalSearch')) throw new Error('No global search panel is mounted')
}

const RECENT_MAX = 5
/** Where recent words are kept: one conversation (「最近在这里搜过」), or EVERYWHERE for a search with none in scope. */
export const EVERYWHERE = '*'
// Per account and scope, view state (lib/viewStateTable). Kept in localStorage before, one record for every scope and no
// account (`gugu.globalSearch.recent`): moved over once into the last signed-in account.
const recentOf = (scope: string): ViewPanel => ({ conversation: scope, panel: 'search-recent' })
takeLegacyLocalStorageForAccount((key) => key === 'gugu.globalSearch.recent', (_, raw, account) => {
  for (const [scope, words] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
    if (Array.isArray(words)) writeViewState({ ...recentOf(scope), account }, { words: words.filter((word): word is string => typeof word === 'string').slice(0, RECENT_MAX) })
  }
})
/** The last words searched in this scope whose result was opened, newest first (this device only). */
export function recentSearches(scope: string): string[] {
  return readViewState<{ words: string[] }>(recentOf(scope)).words ?? []
}
export function rememberSearch(scope: string, text: string): void {
  writeViewState(recentOf(scope), { words: [text, ...recentSearches(scope).filter((old) => old !== text)].slice(0, RECENT_MAX) })
}
export function forgetSearches(scope: string): void {
  clearViewState(recentOf(scope))
}

/** Search one conversation (optionally one sender's messages in it): the global panel, scoped by removable chips. */
export function searchInChat(chatId: string, from?: { userId: string; name: string }): void {
  openGlobalSearch({ chips: from ? [{ kind: 'in', chatId }, { kind: 'from', ...from }] : [{ kind: 'in', chatId }] })
}
