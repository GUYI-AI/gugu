import { useCallback, useRef } from 'react'
import { viewStateCache } from '../session/renderer/lib/stores/view-state-cache'
import { useSelect } from './selectStore'
import { rendererLogger } from './log'
import { readModelAccount } from './readModel'
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
 * `account` defaults to the account the replica follows (readModelAccount: the last one signed in from the first frame,
 * then the published session, held through a session that is merely absent). A store that already holds its account
 * (the drafts, per render) names it, so it never reads another account's entry in the render where the account changes.
 */
export type ViewPanel = { conversation: string; panel: string; persist?: boolean; account?: string }

/** The owner of view state that belongs to the device, not to an account (pane widths, folds). */
export const DEVICE = '@device'

// In-memory entries leave with their account, under the replica's rule: a real sign-out or another person signing in.
let memoryOwner = getRendererSession()?.user?.id ?? readModelAccount().id
observeRendererSession(({ event, session }) => {
  const next = session?.user?.id ?? null
  if (next ? next === memoryOwner : event !== 'SIGNED_OUT') return
  if (memoryOwner) viewStateCache.forgetMemory(prefixOf(memoryOwner))
  memoryOwner = next
})

// The account the table keys by changes (another person signs in, or the first account of a start that had none known):
// what is kept per account is read again by its owner.
const accountListeners = new Set<(account: string | null) => void>()
let keyedAccount = readModelAccount().id
observeRendererSession(() => {
  const next = readModelAccount().id
  if (next === keyedAccount) return
  keyedAccount = next
  for (const listener of [...accountListeners]) listener(next)
})

/** Called with the new account each time the table's account changes. */
export function onViewStateAccount(listener: (account: string | null) => void): () => void {
  accountListeners.add(listener)
  return () => { accountListeners.delete(listener) }
}

const log = rendererLogger('view-state')
const prefixOf = (owner: string) => `view:${owner}/`
const keyOf = ({ conversation, panel, account: owner }: ViewPanel) => `${prefixOf(owner ?? readModelAccount().id ?? '')}${conversation}/${panel}`

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
  const { conversation, panel: name, persist, account } = panel
  const stored = useSelect(viewStateCache.changes, () => readViewState<T>({ conversation, panel: name, persist, account }))
  // A field written back to its initial value is dropped, so a panel left as it started keeps no entry (nothing piles up per chat).
  const initialRef = useRef(initial)
  initialRef.current = initial
  const write = useCallback((patch: Partial<T>) => {
    const next = Object.fromEntries(Object.entries(patch).map(([field, value]) => [field, Object.is(value, (initialRef.current as Record<string, unknown>)[field]) ? undefined : value]))
    writeViewState<T>({ conversation, panel: name, persist, account }, next as Partial<T>)
  }, [conversation, name, persist, account])
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
  const account = readModelAccount().id
  if (account) viewStateCache.forget(`${prefixOf(account)}${conversation}/`)
  viewStateCache.forget(`chat:${conversation}:`)
}

/**
 * View state kept in localStorage before the table (each key read by `move`, which writes it here): moved over once, when
 * the owning module loads, then every matching key goes. A value `move` cannot read is reported and left in place.
 */
export function takeLegacyLocalStorage(match: (key: string) => boolean, move: (key: string, raw: string) => void): void {
  if (typeof localStorage === 'undefined') return
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key && match(key))
  for (const key of keys) {
    try {
      move(key, localStorage.getItem(key) ?? '')
      localStorage.removeItem(key)
    } catch (error) {
      log.error({ key, error: String(error) }, 'old stored view state is malformed; left in place, not moved')
    }
  }
}

const interfaceOf = (name: string, account: string): ViewPanel => ({ conversation: '', panel: `ui:${name}`, account })

/** One small setting of the interface (a pane's width, a fold), the device's unless an account is named. */
export function readInterface<T>(name: string, account: string = DEVICE): T | undefined {
  return readViewState<{ value: T }>(interfaceOf(name, account)).value
}

/** Set it; undefined goes back to the interface's default (no entry). */
export function writeInterface<T>(name: string, value: T | undefined, account: string = DEVICE): void {
  writeViewState<{ value: T }>(interfaceOf(name, account), { value })
}

/** Moves one old localStorage value into an interface setting, parsed by `parse` (undefined = nothing worth keeping). */
export function takeLegacyInterface<T>(legacyKey: string, name: string, parse: (raw: string) => T | undefined): void {
  takeLegacyLocalStorage((key) => key === legacyKey, (_, raw) => writeInterface(name, parse(raw)))
}

/** One interface setting as React state, read through useSelect; setting it back to `initial` keeps no entry. */
export function useInterface<T>(name: string, initial: T, account: string = DEVICE): [T, (value: T) => void] {
  const [stored, write] = useViewState<{ value: T }>(interfaceOf(name, account), { value: initial })
  return [stored.value, useCallback((value: T) => write({ value }), [write])]
}

/**
 * Like takeLegacyLocalStorage, for values that belong to an account but were stored without one: moved into the account
 * the table keys by. A start that knows no account yet (signed out, or an older version that kept no last-account
 * pointer) moves nothing and keeps the old keys; they move when the first account is published.
 */
export function takeLegacyLocalStorageForAccount(match: (key: string) => boolean, move: (key: string, raw: string, account: string) => void): void {
  const run = (account: string) => takeLegacyLocalStorage(match, (key, raw) => move(key, raw, account))
  const account = readModelAccount().id
  if (account) return run(account)
  const stop = onViewStateAccount((next) => {
    if (!next) return
    stop()
    run(next)
  })
}
