import { QueryClient, focusManager, hashKey, useIsFetching, useQueries, useQuery, type Query, type QueryFunctionContext, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { observeRendererSession } from './sessionPublication'
import { recordSnapshotRefusal } from './perfCounters'
import { rendererLogger } from './log'

/**
 * @@@replica — one replica per kind of data a surface shows (open-flicker, owner 2026-11-14).
 * @@@client-state-model — the model this implements (classes, push tiers, invariants): docs/design/client-state-model.md.
 *
 * Responsible for: reading, caching outside any component, prefetching, invalidation and background refresh, the
 * snapshot kept across restarts, and a lifecycle that follows the signed-in account (never the subscribers or the
 * mount). Not responsible for: writes (services stay where they are and hand their result to `set`), push-fed live
 * state (agent presence keeps its own store), or how a surface draws.
 *
 * A reading is `unknown`, a `value`, or an `error`. There is no default: a surface that has never read this data on
 * this device and account draws a neutral placeholder (`<Unknown/>`), never something that looks like a value — a switch
 * drawn off, a 0, an empty-list sentence, a raw id.
 *
 * Queries are key-only (the shape `attachmentQuery` introduced): the client's one queryFn takes the inputs from the key
 * and calls the reader registered at module level, so the cache never keeps a component's render closure alive.
 * Shell and task page are two entries of one build and load the same chunk, so this module (and the client) exists once
 * per document; the PR verifies that on a running Electron rather than trusting a comment.
 */

export type Reading<V> =
  | { state: 'unknown' }
  /** `stale`: a newer answer may be on its way (snapshot, or past `fresh`). `error`: the last refresh (or retried one) failed. */
  | { state: 'value'; value: V; stale: boolean; error: Error | null }
  | { state: 'error'; error: Error }

export const UNKNOWN: Reading<never> = { state: 'unknown' }

type Scope = 'account' | 'device'

type Later<A extends unknown[]> = A extends unknown[] ? A : never

type Definition<A extends unknown[], V> = {
  /** Unique; part of every key and of the snapshot. Change it when the value's shape changes. */
  name: string
  /** `account`: the reader gets the account id and the cache and snapshot leave with the account. `device`: this device's data. */
  scope: Scope
  read: (owner: string, ...args: A) => Promise<V>
  /** How long a value is fresh (ms); past it, a mount or `refresh` reads again in the background. Default 0. */
  fresh?: number
  /** How long an entry nobody shows stays in memory (ms). Default: as long as the account (Infinity). */
  keep?: number
  /**
   * Keep the last value across restarts (localStorage). Display values only: never tokens or credentials. A persisting
   * model declares its limits (@@@client-state-model, persistence): an entry larger than `maxBytes` is not kept (it is
   * unknown on the next start), and only the newest `maxEntries` keys of this model are kept. A refused write is said
   * (console error and a diagnostics counter), ❌ swallowed. The two snapshot blocks (account, device) stay within
   * SNAPSHOT_BUDGET_BYTES summed over their models' limits (a test checks it).
   */
  persist?: {
    maxBytes: number
    maxEntries: number
    /**
     * What of a value is carried across restarts (default: all). Whole fields left out (ones the type has as optional and
     * readers read as "not known yet"), or `undefined` = not kept by definition; never cut short or rewritten. The limits
     * apply to what is carried; applied again on restore.
     */
    carry?: (value: V, ...args: A) => V | undefined
  }
  /**
   * Read again when the window comes back to the foreground: past `fresh`, or always for a model kept current by a push
   * (`fresh: Infinity`), whose feed may have missed what changed while the window was in the background.
   */
  refreshOnFocus?: boolean
  /** `refresh` shares a read already on its way instead of cancelling it (for reads that are retried and polled). */
  refreshJoinsRead?: boolean
  /** Read again this often while a surface shows it (ms); a function (value, failure, arguments) decides per entry (false = not now). */
  refreshEvery?: number | ((value: NoInfer<V> | undefined, error: Error | null, ...args: Later<A>) => number | false)
  /**
   * `always`: read even while the browser says offline — a read that goes to this device (main, the local library) fails
   * loud instead of waiting unknown. A function decides per entry. Default: `always` for `device`, `online` for `account`.
   */
  networkMode?: 'online' | 'always' | ((...args: Later<A>) => 'online' | 'always')
  /**
   * A push-fed model's change feed (pair with `fresh: Infinity`): `start` runs when the first surface showing an entry of
   * a `group` (default: all of the model's, per owner) appears, its return when the last goes. Entries of the group that
   * already hold a value are read again when it starts: what changed while nobody listened.
   */
  watch?: {
    group?: (...args: Later<A>) => unknown
    start: (owner: string, ...args: Later<A>) => () => void
  }
  /** How many times a failed read is retried before the reading is an error (or, per failure and entry, whether). Default 0: fail loud. */
  retry?: number | true | ((failures: number, error: Error, ...args: Later<A>) => boolean)
  retryDelay?: (attempt: number) => number
  /** A synchronous first source on this device (the IM library's copy), shown stale until the read lands; ❌ a second `persist`. */
  local?: (owner: string, ...args: A) => V | undefined | Promise<V | undefined>
  /** How a new answer joins the shown one (keep the order rows were drawn in); default: the new answer replaces it. */
  merge?: (shown: V, next: V) => V
}

const definitions = new Map<string, Definition<unknown[], unknown>>()

const readFromKey = ({ queryKey }: QueryFunctionContext) => {
  const [name, owner, ...args] = queryKey as [string, string, ...unknown[]]
  const definition = definitions.get(name)
  if (!definition) throw new Error(`No replica named ${name}`)
  return definition.read(owner, ...args)
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { queryFn: readFromKey } } })

// Back to the foreground (`refreshOnFocus`) is the page becoming visible or its window being focused: a desktop window
// switched to while visible is a return too (react-query alone hears only visibility).
focusManager.setEventListener((handleFocus) => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
  const back = () => handleFocus()
  window.addEventListener('visibilitychange', back, false)
  window.addEventListener('focus', back, false)
  return () => {
    window.removeEventListener('visibilitychange', back)
    window.removeEventListener('focus', back)
  }
})
queryClient.mount()
/**
 * The failure of a read that has no value, kept while it is read again: react-query empties `error` when the next read
 * starts, turning it back into unknown — a surface remounting on unknown would loop. An answer (or a reset) clears it.
 */
const lastFailure = new Map<string, Error>()

/**
 * First reads a refresh came during: read once more when their attempt answers; `done` settles when
 * that read does (what the refreshes await). Refreshes in one moment share it.
 */
const readAgainAfter = new Map<string, { done: Promise<void>; settle: () => void }>()

function markReadAgain(query: Query): Promise<void> {
  let marked = readAgainAfter.get(query.queryHash)
  if (!marked) {
    let settle!: () => void
    marked = { done: new Promise<void>((resolve) => { settle = resolve }), settle }
    readAgainAfter.set(query.queryHash, marked)
  }
  return marked.done
}

function followReadAgain(query: Query, action: string): void {
  const marked = readAgainAfter.get(query.queryHash)
  if (!marked || (action !== 'success' && action !== 'error' && action !== 'failed')) return
  readAgainAfter.delete(query.queryHash)
  // An attempt that failed and waits to be retried is not waited for: the read the refresh announced runs now.
  if (action === 'failed') void query.cancel({ silent: true })
  void Promise.resolve().then(() => queryClient.refetchQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }))
    .catch(() => undefined).then(marked.settle)
}

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === 'updated' && event.action.type === 'error' && event.query.state.data === undefined) lastFailure.set(event.query.queryHash, event.action.error)
  if ((event.type === 'updated' && event.action.type === 'success') || event.type === 'removed') lastFailure.delete(event.query.queryHash)
  if (event.type === 'updated') followReadAgain(event.query, event.action.type)
  if (event.type === 'removed') { readAgainAfter.get(event.query.queryHash)?.settle(); readAgainAfter.delete(event.query.queryHash) }
  const name = String(event.query.queryKey[0])
  if (event.type === 'added' && definitions.has(name) && event.query.options.queryFn !== readFromKey) {
    throw new Error(`Replica query ${JSON.stringify(event.query.queryKey)} brings its own queryFn`)
  }
  if (event.type === 'added') seedFromLocal(event.query.queryKey)
  const persist = definitions.get(name)?.persist
  if (event.type === 'updated' && event.action.type === 'success' && persist && !restoring) {
    writeSnapshotEntry(event.query.queryKey, event.query.state.data, event.query.state.dataUpdatedAt, persist)
  }
  if (event.type === 'observerAdded' && persist) noteUse(event.query.queryKey)
  if (event.type === 'observerAdded' || event.type === 'observerRemoved') followWatch(event.query, event.type === 'observerAdded' ? 1 : -1)
})

/** The feeds of `watch` models now running: one per model, owner and group, with how many surfaces hold it. */
const watches = new Map<string, { users: number; stop: () => void }>()

/** The feed each shown entry opened, released under the same group (a group can move, e.g. a project to another machine). */
const feedsOf = new WeakMap<Query, string[]>()

function followWatch(query: Query, delta: 1 | -1): void {
  const [name, owner, ...args] = query.queryKey as [string, string, ...unknown[]]
  if (!definitions.get(name)?.watch) return
  if (delta > 0) {
    const id = holdFeed(name, owner, args)
    feedsOf.set(query, [...(feedsOf.get(query) ?? []), id])
  } else {
    const id = feedsOf.get(query)?.pop()
    if (id) releaseFeed(id)
  }
}

function feedId(name: string, owner: string, args: unknown[]): string {
  const group = definitions.get(name)!.watch!.group
  return hashKey([name, owner, group ? group(...args) : null])
}

/** Start (or join) the feed of this entry's group; a group starting reads again what it already holds. */
function holdFeed(name: string, owner: string, args: unknown[]): string {
  const definition = definitions.get(name)!
  const id = feedId(name, owner, args)
  const running = watches.get(id)
  if (running) { running.users += 1; return id }
  watches.set(id, { users: 1, stop: definition.watch!.start(owner, ...args) })
  const held = queryClient.getQueryCache().findAll({ queryKey: [name, owner] })
    .filter((entry) => entry.state.data !== undefined && feedId(name, owner, entry.queryKey.slice(2)) === id)
  // As `refresh`: a read already on its way began before the feed listened, so it is replaced (unless the model shares reads).
  for (const entry of held) void queryClient.invalidateQueries({ queryKey: entry.queryKey, exact: true }, { cancelRefetch: !definition.refreshJoinsRead })
  return id
}

function releaseFeed(id: string): void {
  const running = watches.get(id)
  if (!running || --running.users > 0) return
  watches.delete(id)
  running.stop()
}

/** Put a value under a key, living as long as its model keeps it (❌ react-query's five minutes for an unwatched entry). */
function putValue(key: QueryKey, value: unknown): void {
  const patch = typeof value === 'function'
  const next = patch ? (value as (old: unknown) => unknown)(queryClient.getQueryData(key)) : value
  if (next === undefined) return
  // A patch of a value still to be read again (restored, seeded) is still to be read again: only a whole answer is current.
  const pending = patch && !!queryClient.getQueryState(key)?.isInvalidated
  putEntry(key, next)
  if (pending) void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' })
}

let restoring = false

/** An entry restored from the snapshot: shown at once, marked to be read again whatever `fresh` says (I5). */
function restoreEntry(key: QueryKey, value: unknown, at: number): void {
  restoring = true
  try {
    putEntry(key, value, at)
  } finally {
    restoring = false
  }
  void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' })
}

function putEntry(key: QueryKey, value: unknown, updatedAt?: number): void {
  const keep = definitions.get(String(key[0]))?.keep ?? Infinity
  queryClient.getQueryCache().build(queryClient, { queryKey: key, gcTime: keep })
  queryClient.setQueryData(key, value, updatedAt === undefined ? undefined : { updatedAt })
}

function seedFromLocal(key: QueryKey): void {
  const [name, owner, ...args] = key as [string, string, ...unknown[]]
  const local = definitions.get(name)?.local
  if (!local || queryClient.getQueryData(key) !== undefined) return
  // Marked to be read again whatever `fresh` says (I5).
  const put = (value: unknown) => {
    if (value === undefined || queryClient.getQueryData(key) !== undefined) return
    putEntry(key, value, 0)
    void queryClient.invalidateQueries({ queryKey: key, exact: true }, { cancelRefetch: false })
  }
  const fail = (error: unknown) => { replicaLog.error({ model: name, error }, `${name}: the local copy could not be read`) }
  let answer: unknown
  try { answer = local(owner, ...args) } catch (error) { fail(error); return }
  if (answer instanceof Promise) answer.then(put, fail)
  else put(answer)
}

// ── account lifecycle ────────────────────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_PREFIX = 'gugu.readModel.v1:'
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 3600_000
/** What each snapshot block (an account's, the device's) may hold at most: the sum of its models' maxBytes × maxEntries. */
export const SNAPSHOT_BUDGET_BYTES = 64 * 1024

const replicaLog = rendererLogger('replica')

function refuseSnapshotWrite(name: string, reason: string): void {
  recordSnapshotRefusal()
  replicaLog.error({ model: name, reason }, `${name}: not kept across restarts — ${reason}`)
}
const LAST_ACCOUNT_KEY = 'gugu.readModel.v1.account'
const DEVICE = 'device'

const accountListeners = new Set<() => void>()
type AccountState = { id: string | null; live: boolean }
let account: AccountState = { id: readLastAccount(), live: false }

function readLastAccount(): string | null {
  try { return localStorage.getItem(LAST_ACCOUNT_KEY) } catch { return null }
}

function setAccount(next: AccountState): void {
  if (next.id === account.id && next.live === account.live) return
  account = next
  try {
    if (next.id) localStorage.setItem(LAST_ACCOUNT_KEY, next.id)
    else localStorage.removeItem(LAST_ACCOUNT_KEY)
  } catch { /* the pointer only speeds up the next start */ }
  accountListeners.forEach((listener) => listener())
}

/** Drop everything this account read: memory and snapshot. */
function forgetAccount(id: string): void {
  queryClient.removeQueries({ predicate: (query) => definitions.has(String(query.queryKey[0])) && query.queryKey[1] === id })
  try { localStorage.removeItem(SNAPSHOT_PREFIX + id) } catch { /* nothing stored */ }
}

/** The account follows the published session: only a real sign-out or another person clears; a merely absent session holds. */
export function followRendererSession(event: string, userId: string | null): void {
  if (userId) {
    if (account.id && account.id !== userId) forgetAccount(account.id)
    // The account moves first, then its kept entries are restored: `subscribe` followers hear them as this account's.
    const arriving = account.id !== userId
    setAccount({ id: userId, live: true })
    if (arriving) hydrateSnapshot(userId)
    return
  }
  if (event === 'SIGNED_OUT') {
    if (account.id) forgetAccount(account.id)
    setAccount({ id: null, live: false })
    return
  }
  setAccount({ id: account.id, live: false })
}

observeRendererSession(({ event, session }) => followRendererSession(event, session?.user.id ?? null))

function subscribeAccount(listener: () => void): () => void {
  accountListeners.add(listener)
  return () => { accountListeners.delete(listener) }
}
const accountSnapshot = () => account

// ── snapshot across restarts ─────────────────────────────────────────────────────────────────────────────────────

/** `at`: when the value was read (decides `fresh`). `used`: when a surface last showed it (decides which entries stay). */
type SnapshotEntry = { key: QueryKey; value: unknown; at: number; used?: number }
type Snapshot = Record<string, SnapshotEntry>
type Limits = NonNullable<Definition<unknown[], unknown>['persist']>

/**
 * When a surface last showed an entry (showing now = now; never shown = 0). Noted in memory on mount and written once the
 * renderer is idle (`flushUses`), ❌ a whole-block rewrite per mounting key on the first frame.
 */
function lastUse(entry: SnapshotEntry, now: number): number {
  const shown = (queryClient.getQueryCache().find({ queryKey: entry.key, exact: true })?.getObserversCount() ?? 0) > 0
  return shown ? now : Math.max(entry.used ?? 0, usesNoted.get(hashKey(entry.key)) ?? 0)
}

/** Least recently used last; among never-shown entries, the least recently read last. */
const byUse = (now: number) => (x: SnapshotEntry, y: SnapshotEntry) => lastUse(y, now) - lastUse(x, now) || y.at - x.at

const usesNoted = new Map<string, number>()
let usesFlush: ReturnType<typeof setTimeout> | null = null

function noteUse(key: QueryKey): void {
  const owner = String(key[1])
  if (owner !== DEVICE && owner !== account.id) return
  usesNoted.set(hashKey(key), Date.now())
  if (usesFlush) return
  const later = (globalThis as { requestIdleCallback?: (run: () => void, options: { timeout: number }) => unknown }).requestIdleCallback
  usesFlush = setTimeout(() => {
    if (later) later(flushUses, { timeout: 5_000 })
    else flushUses()
  }, USES_FLUSH_AFTER_MS)
}

const USES_FLUSH_AFTER_MS = 2_000

export function flushUses(): void {
  usesFlush = null
  const noted = new Map(usesNoted)
  for (const owner of new Set([DEVICE, ...(account.id ? [account.id] : [])])) {
    const snapshot = readSnapshot(owner)
    let changed = false
    for (const [hash, used] of noted) {
      const entry = snapshot[hash]
      if (entry && (entry.used ?? 0) < used) { entry.used = used; changed = true }
    }
    if (!changed) continue
    try { localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot)) } catch { /* a use not recorded only weakens the next eviction */ }
  }
}

function dropKept(key: QueryKey): void {
  const owner = String(key[1])
  const snapshot = readSnapshot(owner)
  const hash = hashKey(key)
  if (!snapshot[hash]) return
  delete snapshot[hash]
  try { localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot)) } catch { /* the entry is gone from memory anyway */ }
}

function readSnapshot(owner: string): Snapshot {
  try {
    const raw = localStorage.getItem(SNAPSHOT_PREFIX + owner)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed as Snapshot : {}
  } catch {
    return {}
  }
}

function writeSnapshotEntry(key: QueryKey, read: unknown, at: number, limits: Limits): void {
  const owner = String(key[1])
  if (owner !== DEVICE && owner !== account.id) return
  const name = String(key[0])
  const value = limits.carry ? limits.carry(read, ...key.slice(2)) : read
  const snapshot = readSnapshot(owner)
  const hash = hashKey(key)
  if (value === undefined) {
    // Not kept by definition: nothing to refuse; an older copy (an earlier definition kept it) leaves.
    if (!snapshot[hash]) return
    delete snapshot[hash]
    try { localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot)) } catch { /* the entry is gone from memory's view anyway */ }
    return
  }
  // Entries are dropped by age: models load with their chunks, so "not registered yet" is not "gone". A model whose
  // value changes shape takes a new name; its old entries age out here.
  for (const [hash, entry] of Object.entries(snapshot)) {
    if (!(entry?.at > Date.now() - SNAPSHOT_MAX_AGE_MS)) delete snapshot[hash]
  }
  const now = Date.now()
  const used = Math.max(snapshot[hash]?.used ?? 0, usesNoted.get(hash) ?? 0)
  const entry: SnapshotEntry = { key, value, at, ...(used ? { used } : {}) }
  const bytes = JSON.stringify(entry).length
  if (bytes > limits.maxBytes) {
    // Over its declared size: the older copy is not kept either, so the next start reads it as unknown.
    delete snapshot[hash]
    refuseSnapshotWrite(name, `entry is ${bytes} B, its limit ${limits.maxBytes} B`)
  } else {
    snapshot[hash] = entry
    // The least recently used leave (❌ least recently read: a background read must not push out a shown row).
    const own = Object.entries(snapshot).filter(([, kept]) => kept.key[0] === name).sort(([, x], [, y]) => byUse(now)(x, y))
    for (const [evicted] of own.slice(limits.maxEntries)) delete snapshot[evicted]
  }
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot))
  } catch (error) {
    refuseSnapshotWrite(name, `storage refused the ${owner === DEVICE ? 'device' : 'account'} block (${String(error)})`)
  }
}

/** What a model as defined now admits of its kept entries (an older build's snapshot goes no further): none without `persist`, each within `maxBytes`, the newest `maxEntries`. */
function admitted(definition: Definition<unknown[], unknown>, entries: SnapshotEntry[]): SnapshotEntry[] {
  if (!definition.persist) return []
  const { maxBytes, maxEntries, carry } = definition.persist
  const now = Date.now()
  const carried = entries.flatMap((entry) => {
    const value = carry ? carry(entry.value, ...entry.key.slice(2)) : entry.value
    // Carried as it was kept (by content: a carry that returns a new object of the same fields changes nothing).
    const same = value === entry.value || JSON.stringify(value) === JSON.stringify(entry.value)
    return value === undefined ? [] : [{ entry, as: same ? entry : { ...entry, value } }]
  })
  return carried
    .filter(({ as }) => JSON.stringify(as).length <= maxBytes)
    .sort((x, y) => byUse(now)(x.as, y.as))
    .slice(0, maxEntries)
    .map(({ as }) => as)
}

function ownEntries(snapshot: Snapshot, owner: string): Map<string, SnapshotEntry[]> {
  const byName = new Map<string, SnapshotEntry[]>()
  for (const entry of Object.values(snapshot)) {
    if (!Array.isArray(entry?.key) || entry.key[1] !== owner) continue
    const name = String(entry.key[0])
    byName.set(name, [...(byName.get(name) ?? []), entry])
  }
  return byName
}

/** Seed the cache with the last run's values, dated when read; a model not registered yet is judged when it registers. */
function hydrateSnapshot(owner: string): void {
  const snapshot = readSnapshot(owner)
  const settled: Settled = { dropped: [], carried: [] }
  for (const [name, entries] of ownEntries(snapshot, owner)) {
    const definition = definitions.get(name)
    const keep = definition ? judge(definition, entries, settled) : entries
    for (const entry of keep) {
      if (queryClient.getQueryData(entry.key) === undefined) restoreEntry(entry.key, entry.value, entry.at)
    }
  }
  settleSnapshot(owner, snapshot, settled)
}

/** A model registering for the first time: kept entries it does not admit leave; ones it carries differently are seeded again. */
function pruneSnapshot(definition: Definition<unknown[], unknown>): void {
  for (const owner of definition.scope === DEVICE ? [DEVICE] : account.id ? [account.id] : []) {
    const snapshot = readSnapshot(owner)
    const settled: Settled = { dropped: [], carried: [] }
    judge(definition, ownEntries(snapshot, owner).get(definition.name) ?? [], settled)
    for (const entry of settled.dropped) queryClient.removeQueries({ queryKey: entry.key, exact: true })
    for (const entry of settled.carried) {
      if (queryClient.getQueryState(entry.key)?.dataUpdatedAt === entry.at) restoreEntry(entry.key, entry.value, entry.at)
    }
    settleSnapshot(owner, snapshot, settled)
  }
}

type Settled = { dropped: SnapshotEntry[]; carried: SnapshotEntry[] }

function judge(definition: Definition<unknown[], unknown>, entries: SnapshotEntry[], settled: Settled): SnapshotEntry[] {
  const keep = admitted(definition, entries)
  const kept = new Map(keep.map((entry) => [hashKey(entry.key), entry]))
  for (const entry of entries) {
    const as = kept.get(hashKey(entry.key))
    if (!as) settled.dropped.push(entry)
    else if (as !== entry) settled.carried.push(as)
  }
  return keep
}

function settleSnapshot(owner: string, snapshot: Snapshot, { dropped, carried }: Settled): void {
  if (dropped.length === 0 && carried.length === 0) return
  for (const entry of dropped) delete snapshot[hashKey(entry.key)]
  for (const entry of carried) snapshot[hashKey(entry.key)] = entry
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot))
  } catch (error) {
    refuseSnapshotWrite(String([...dropped, ...carried][0]!.key[0]), `storage refused the ${owner === DEVICE ? 'device' : 'account'} block (${String(error)})`)
  }
}

hydrateSnapshot(DEVICE)
if (account.id) hydrateSnapshot(account.id)

// ── models ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Replica<A extends unknown[], V> = {
  readonly name: string
  /** The key for these arguments, or null while there is no account to read for. */
  key(...args: A): QueryKey | null
  /** What a surface opening now would show, synchronously. */
  peek(...args: A): Reading<V>
  /** Read now unless fresh; never throws (the error lands in the reading). */
  prefetch(...args: A): Promise<void>
  /** Read now unless fresh, and return the value. */
  fetch(...args: A): Promise<V>
  /** Put a value a write returned (synchronously, for the account signed in now). */
  set(args: A, value: V | ((old: V | undefined) => V | undefined)): void
  /** The entry for these arguments, bound to the account signed in now: for a value that arrives after an await. */
  at(...args: A): { set(value: V | ((old: V | undefined) => V | undefined)): void }
  /** Mark stale and read again where shown; without arguments, every entry of this model. */
  refresh(...args: Partial<A>): Promise<void>
  /** Hear when an entry changes, for code outside React (React: `useReplica`). Arguments left out match any; only the current account's entries. */
  subscribe(args: Partial<A>, listener: (entry: Entry<A, V>) => void): () => void
  /** The entries of this model now held for the account signed in (arguments left out match any): a one-moment look. */
  entries(...args: Partial<A>): Entry<A, V>[]
  /** Whether a read of this entry is on its way now (a one-moment decision, e.g. whether a change predates it). */
  isFetching(...args: A): boolean
  /** Drop what is shown for these arguments (unknown again) and read again where it is shown; never throws. */
  reset(...args: A): Promise<void>
  /** Keep this entry's `watch` feed running as a surface would, for a reader that peeks without showing. Returns the release. */
  hold(...args: A): () => void
  /** @internal */ options(key: QueryKey): object
}

export type Entry<A extends unknown[], V> = { args: A; reading: Reading<V>; fetching: boolean }

function ownerOf(scope: Scope): string | null {
  return scope === DEVICE ? DEVICE : account.id
}

export function replica<A extends unknown[], V>(definition: Definition<A, V>): Replica<A, V> {
  // A module evaluated again (hot reload, a test's module reset) defines its model again: the latest reader serves.
  const first = !definitions.has(definition.name)
  definitions.set(definition.name, definition as Definition<unknown[], unknown>)
  // Judged once the defining module has run (a microtask, before anything renders): its `carry` may read what that module
  // declares below the model — at definition time those are in their temporal dead zone (the app would start blank).
  // In that window synchronous code can `peek` a kept entry not judged yet; an entry the judgement drops is removed
  // whatever happened to it meanwhile (only a carried one checks it was not read again first).
  if (first) queueMicrotask(() => pruneSnapshot(definition as Definition<unknown[], unknown>))
  queryClient.setQueryDefaults([definition.name], { gcTime: definition.keep ?? Infinity })
  const options = (key: QueryKey) => ({
    queryKey: key,
    staleTime: definition.fresh ?? 0,
    gcTime: definition.keep ?? Infinity,
    retry: typeof definition.retry === 'function' ? retryOf(definition.retry, key) : definition.retry ?? false,
    ...(definition.retryDelay ? { retryDelay: definition.retryDelay } : {}),
    ...(definition.refreshEvery ? { refetchInterval: refetchIntervalOf(definition.refreshEvery, key) } : {}),
    refetchOnWindowFocus: definition.refreshOnFocus ? (definition.fresh === Infinity ? 'always' as const : true) : false,
    networkMode: typeof definition.networkMode === 'function' ? definition.networkMode(...(key.slice(2) as Later<A>))
      : definition.networkMode ?? (definition.scope === DEVICE ? 'always' : 'online'),
    ...(definition.merge ? { structuralSharing: (shown: unknown, next: unknown) => shown === undefined ? next : definition.merge!(shown as V, next as V) } : {}),
  })
  const key = (...args: A): QueryKey | null => {
    const owner = ownerOf(definition.scope)
    return owner ? [definition.name, owner, ...args] : null
  }
  const matches = (queryKey: QueryKey, args: Partial<A>) => {
    const owner = ownerOf(definition.scope)
    return queryKey[0] === definition.name && !!owner && queryKey[1] === owner
      && args.every((arg, index) => arg === undefined || hashKey([queryKey[index + 2]]) === hashKey([arg]))
  }
  const entryOf = (query: Query): Entry<A, V> => ({
    args: query.queryKey.slice(2) as A,
    reading: readingOfState(query.state, query.isStaleByTime(definition.fresh ?? 0), query.queryKey) as Reading<V>,
    fetching: query.state.fetchStatus === 'fetching',
  })
  const requireKey = (args: A): QueryKey => {
    const k = key(...args)
    if (!k) throw new Error(`${definition.name}: no signed-in account to read for`)
    return k
  }
  return {
    name: definition.name,
    key,
    options,
    peek: (...args) => {
      const k = key(...args)
      // Judged by `fresh`, not by react-query's observers: a value nobody shows is not fresh because nobody watches it.
      return k ? readingOfState(queryClient.getQueryState(k), queryClient.getQueryCache().find({ queryKey: k, exact: true })?.isStaleByTime(definition.fresh ?? 0) ?? true, k) : UNKNOWN
    },
    prefetch: (...args) => {
      const k = key(...args)
      return k ? queryClient.prefetchQuery(options(k)) : Promise.resolve()
    },
    fetch: (...args) => queryClient.fetchQuery(options(requireKey(args))) as Promise<V>,
    set: (args, value) => { putValue(requireKey(args), value) },
    at: (...args) => {
      // Bound now: a write that answers after the account changed lands in the account that asked, ❌ in the next one.
      const k = requireKey(args)
      return { set: (value) => { if (k[1] === ownerOf(definition.scope)) putValue(k, value) } }
    },
    subscribe: (args, listener) => queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' && event.type !== 'removed') return
      if (!matches(event.query.queryKey, args)) return
      listener(event.type === 'removed'
        ? { args: event.query.queryKey.slice(2) as A, reading: UNKNOWN, fetching: false }
        : entryOf(event.query))
    }),
    entries: (...args) => queryClient.getQueryCache().findAll({ queryKey: [definition.name] })
      .filter((query) => matches(query.queryKey, args)).map(entryOf),
    isFetching: (...args) => {
      const k = key(...args)
      return !!k && queryClient.getQueryState(k)?.fetchStatus === 'fetching'
    },
    hold: (...args) => {
      const k = key(...args)
      if (!k || !definition.watch) return () => undefined
      const id = holdFeed(definition.name, k[1] as string, args)
      let held = true
      return () => { if (held) { held = false; releaseFeed(id) } }
    },
    reset: async (...args) => {
      const k = key(...args)
      if (!k) return
      // The kept copy goes too: a reset whose read never lands must not come back at the next start.
      dropKept(k)
      lastFailure.delete(hashKey(k))
      await queryClient.resetQueries({ queryKey: k, exact: true }).catch(() => undefined)
    },
    refresh: async (...args) => {
      const owner = ownerOf(definition.scope)
      if (!owner) return
      // An argument left out matches any value in its place (❌ dropped, which would shift the ones after it left).
      const filters = {
        queryKey: [definition.name, owner],
        predicate: (query: { queryKey: QueryKey }) => args.every((arg, index) => arg === undefined || hashKey([query.queryKey[index + 2]]) === hashKey([arg])),
      }
      // A first read on its way is not restarted: marked, and read once more when its attempt answers (`readAgainAfter`);
      // refreshes in one moment are that one read. A later read is cancelled and read again.
      const firstReads = queryClient.getQueryCache().findAll(filters)
        .filter((query) => query.state.fetchStatus !== 'idle' && query.state.data === undefined)
      // One waiting out a retry after a failure has no attempt on its way: read now (its awaiters get the new read's answer).
      const backingOff = definition.refreshJoinsRead ? [] : firstReads.filter((query) => query.state.fetchFailureCount > 0)
      const marked = firstReads.filter((query) => !backingOff.includes(query)).map(markReadAgain)
      const restarted = backingOff.map((query) => {
        void query.cancel({ silent: true })
        return query.fetch().catch(() => undefined)
      })
      await queryClient.invalidateQueries(filters, { cancelRefetch: !definition.refreshJoinsRead })
      await Promise.all([...restarted, ...marked])
    },
  }
}

/** react-query asks the interval and the retry of the query; a definition asks them of the value shown, the failure and its arguments. */
function refetchIntervalOf<A extends unknown[], V>(every: number | ((value: V | undefined, error: Error | null, ...args: A) => number | false), key: QueryKey) {
  return typeof every === 'number' ? every
    : (query: { state: { data: unknown; error: Error | null } }) => every(query.state.data as V | undefined, query.state.error, ...(key.slice(2) as A))
}
function retryOf<A extends unknown[]>(retry: (failures: number, error: Error, ...args: A) => boolean, key: QueryKey) {
  return (failures: number, error: Error) => retry(failures, error, ...(key.slice(2) as A))
}

function readingOfState(state: { data: unknown; error: Error | null; fetchFailureReason: Error | null; status: string } | undefined, stale: boolean, key: QueryKey): Reading<never> {
  if (!state) return UNKNOWN
  // While a failed refresh is retried, the failure is said already (react-query keeps `error` empty until it gives up).
  if (state.data !== undefined) return { state: 'value', value: state.data as never, stale, error: state.error ?? state.fetchFailureReason }
  const error = state.error ?? lastFailure.get(hashKey(key))
  return error ? { state: 'error', error } : UNKNOWN
}

function readingOf<V>(result: UseQueryResult<V>, key: QueryKey): Reading<V> {
  if (result.data !== undefined) return { state: 'value', value: result.data, stale: result.isStale, error: result.error ?? result.failureReason }
  const error = result.error ?? lastFailure.get(hashKey(key))
  return error ? { state: 'error', error } : UNKNOWN
}

const IDLE_KEY = ['read-model:idle'] as const

/** The reading for these arguments; `null` = no subject (`unknown`, nothing requested). Account models read only while the session is live. */
export function useReplica<A extends unknown[], V>(model: Replica<A, V>, args: A | null, options: { read?: boolean } = {}): Reading<V> {
  const current = useSyncExternalStore(subscribeAccount, accountSnapshot)
  const definition = definitions.get(model.name)!
  const k = args ? model.key(...args) : null
  // `read: false`: show what is there (a snapshot, another reader's value) without asking yet.
  const canRead = !!k && options.read !== false && (definition.scope === DEVICE || current.live)
  const result = useQuery({ ...(model.options(k ?? IDLE_KEY) as { queryKey: QueryKey }), enabled: canRead }, queryClient) as UseQueryResult<V>
  return k ? readingOf(result, k) : UNKNOWN
}

/** One reading per subject (rows of a list), in the order given. */
export function useReplicas<A extends unknown[], V>(model: Replica<A, V>, argsList: readonly A[]): Reading<V>[] {
  const current = useSyncExternalStore(subscribeAccount, accountSnapshot)
  const definition = definitions.get(model.name)!
  const canRead = definition.scope === DEVICE || current.live
  const keys = argsList.map((args) => model.key(...args))
  const results = useQueries({
    queries: keys.map((k) => ({ ...(model.options(k ?? IDLE_KEY) as { queryKey: QueryKey }), enabled: !!k && canRead })),
  }, queryClient) as UseQueryResult<V>[]
  return results.map((result, index) => (keys[index] ? readingOf(result, keys[index]!) : UNKNOWN))
}

/** Test seam: the live session as the replica sees it. */
export function replicaAccount(): AccountState { return account }

/** Whether a read of this model's entry (arguments left out match any) is on its way now: e.g. a check running. */
export function useReplicaFetching<A extends unknown[], V>(model: Replica<A, V>, args: Partial<A> | null): boolean {
  useSyncExternalStore(subscribeAccount, accountSnapshot)
  const owner = model.key(...([] as unknown as A))?.[1] ?? null
  return useIsFetching({
    queryKey: [model.name],
    predicate: (query) => args !== null && owner !== null && query.queryKey[1] === owner
      && args.every((arg, index) => arg === undefined || hashKey([query.queryKey[index + 2]]) === hashKey([arg])),
  }, queryClient) > 0
}
