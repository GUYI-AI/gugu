import { useCallback, useRef } from 'react'
import { viewStateCache } from '../session/renderer/lib/stores/view-state-cache'
import { useSelect } from './selectStore'
import { getRendererSession, observeRendererSession } from './sessionPublication'

/**
 * @@@view-state-table - view state (③ in the client state model) keyed by (account, conversation, panel): a panel's search
 * words, what is expanded, an edit not saved yet. A component reads and writes its panel's entry here instead of keeping it
 * in its own state, so switching away, a remount or a new React key no longer loses it.
 *
 * Stored in the view-state cache, which has every entry from the first frame (desktop: main's database through preload;
 * web and phone: localStorage). Each panel kind has caps (view-state-models.ts). A panel marked `persist: false` stays in
 * memory only: a settings dialog's unsaved edit is gone after a restart, by design. View state has no `unknown`: nothing
 * written yet is the panel's initial value. The account's in-memory entries leave when it signs out; a conversation left
 * or deleted takes its entries with it (forgetConversation).
 *
 * `account` defaults to the signed-in one; a store that already holds its account (the drafts, per render) names it, so
 * it never reads another account's entry in the render where the account changes.
 */
export type ViewPanel = { conversation: string; panel: string; persist?: boolean; account?: string }

let account = getRendererSession()?.user?.id ?? null
observeRendererSession(({ session }) => {
  const next = session?.user?.id ?? null
  if (next === account) return
  if (account) viewStateCache.forgetMemory(prefixOf(account))
  account = next
})

const prefixOf = (owner: string) => `view:${owner}/`
const keyOf = ({ conversation, panel, account: owner }: ViewPanel) => `${prefixOf(owner ?? account ?? '')}${conversation}/${panel}`

/** Read the entry of a panel (outside React: tests, actions). */
export function readViewState<T extends object>(panel: ViewPanel): Partial<T> {
  return (viewStateCache.read(keyOf(panel), panel.persist !== false) as Partial<T> | undefined) ?? {}
}

/** Change fields of a panel's entry; a field set to undefined goes back to the panel's initial value. */
export function writeViewState<T extends object>(panel: ViewPanel, patch: Partial<T>): void {
  if (left.has(panel.conversation)) return
  const next: Record<string, unknown> = { ...readViewState<T>(panel), ...patch }
  for (const field of Object.keys(next)) if (next[field] === undefined) delete next[field]
  viewStateCache.write(keyOf(panel), Object.keys(next).length ? next : undefined, panel.persist !== false)
}

/** A panel's view state: its stored fields over `initial`, and a writer. */
export function useViewState<T extends object>(panel: ViewPanel, initial: T): [T, (patch: Partial<T>) => void] {
  const { conversation, panel: name, persist } = panel
  const stored = useSelect(viewStateCache.changes, () => readViewState<T>({ conversation, panel: name, persist }))
  // A field written back to its initial value is dropped, so a panel left as it started keeps no entry (nothing piles up per chat).
  const initialRef = useRef(initial)
  initialRef.current = initial
  const write = useCallback((patch: Partial<T>) => {
    const next = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, Object.is(value, (initialRef.current as Record<string, unknown>)[field]) ? undefined : value]))
    writeViewState<T>({ conversation, panel: name, persist }, next as Partial<T>)
  }, [conversation, name, persist])
  return [{ ...initial, ...stored }, write]
}

/** Drop a panel's entry (an edit saved). */
export function clearViewState(panel: ViewPanel): void {
  viewStateCache.write(keyOf(panel), undefined, panel.persist !== false)
}

/** Every stored entry of one panel kind for an account, by conversation, oldest write first (all the drafts). */
export function readPanelEntries<T extends object>(panel: string, owner: string): Array<[conversation: string, entry: Partial<T>]> {
  const prefix = prefixOf(owner), suffix = `/${panel}`
  return viewStateCache.keys(prefix).filter((key) => key.endsWith(suffix))
    .map((key) => [key.slice(prefix.length, -suffix.length), viewStateCache.read(key) as Partial<T>])
}

// A conversation is live, or left: forgetConversation makes it left, and a viewport showing it again (joined again, say)
// makes it live. A left conversation takes no writes — its panels unmount after it is forgotten and would otherwise save
// once more on the way out (where it was read to).
const left = new Set<string>()

/** A viewport shows this conversation: it takes writes again. */
export function showConversation(conversation: string): void {
  left.delete(conversation)
}

/** A conversation left or deleted: its panels' entries and its tab strip go, and it takes no writes until shown again. */
export function forgetConversation(conversation: string): void {
  left.add(conversation)
  if (account) viewStateCache.forget(`${prefixOf(account)}${conversation}/`)
  viewStateCache.forget(`chat:${conversation}:`)
}
