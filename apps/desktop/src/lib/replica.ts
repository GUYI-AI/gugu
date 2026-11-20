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
  | { state: 'value'; value: V; stale: boolean; error: Error | null; retry?: Retry }
  | { state: 'error'; error: Error; retry?: Retry }

/**
 * Read this entry again (what a surface's 「重试」 does), bound to the reading's own arguments: ❌ a closure per surface naming
 * the model and its arguments again. Every reading the replica hands out carries it (one function per entry, so it is
 * stable across renders); a reading a test or an adapter builds by hand may leave it out.
 */
export type Retry = () => Promise<void>

export const UNKNOWN: Reading<never> = { state: 'unknown' }

/**
 * The failure a surface says for a reading (with components/ui/RefreshFailed): an error reading's, or a refresh that failed
 * over a value it still shows. null = nothing to say. ❌ only `state === 'error'`: the old value would read as current.
 */
export function refreshFailure(reading: Reading<unknown>): Error | null {
  return reading.state === 'unknown' ? null : reading.error
}

/** The reading's own retry, for a 「重试」 drawn by hand beside its failure (none before the first answer). */
export function retryOf(reading: Reading<unknown>): (() => void) | undefined {
  const retry = reading.state === 'unknown' ? undefined : reading.retry
  return retry ? () => void retry() : undefined
}

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
  persist?: { maxBytes: number; maxEntries: number }
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
  /** Groups this model belongs to: `refreshTag(tag, …args)` reads every model of the group again (❌ a hand-written fan-out). */
  tags?: readonly string[]
}

const definitions = new Map<string, Definition<unknown[], unknown>>()

/**
 * @@@write-over-read — writes put on an entry (`set`, `at().set`: a write's answer, a push), counted per entry. A read
 * that began before a write cannot overwrite it: when it lands (answered or failed) after a write, the written value stays
 * — it is the newer one. ❌ A counter per caller (the rule is the replica's, for every model).
 */
const writes = new Map<string, number>()

const readFromKey = async ({ queryKey }: QueryFunctionContext) => {
  const [name, owner, ...args] = queryKey as [string, string, ...unknown[]]
  const definition = definitions.get(name)
  if (!definition) throw new Error(`No replica named ${name}`)
  const hash = hashKey(queryKey)
  const before = writes.get(hash) ?? 0
  const overtaken = () => (writes.get(hash) ?? 0) !== before && queryClient.getQueryData(queryKey) !== undefined
  try {
    const value = await definition.read(owner, ...args)
    if (!overtaken()) return value
  } catch (error) {
    if (!overtaken()) throw error
  }
  return queryClient.getQueryData(queryKey)
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { queryFn: readFromKey } } })

/**
 * The app's returns to the foreground (`refreshOnFocus`): `watch(back)` calls `back` once each time the person comes back
 * to the app after having left it, and returns its stop. Installed by the app's entry (lib/foregroundReturn.ts); without
 * it, react-query's own page visibility applies. It only says "back": whether the app is in the foreground for polling
 * stays the page's visibility (a poll keeps running while another application has the focus).
 */
export function readOnReturn(watch: (back: () => void) => () => void): void {
  focusManager.setEventListener((handleFocus) => watch(() => handleFocus()))
}

/** Hear the returns `readOnReturn` reports (the same moment `refreshOnFocus` models read), for a follower outside React. */
export function onReturn(listener: () => void): () => void {
  return focusManager.subscribe((focused) => { if (focused) listener() })
}

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
  // A feed that cannot start (that machine has no connection now) is said and left out: the entry is still read, and a
  // reconnect reads it again (❌ one unreachable machine breaking every surface that shows its entries).
  let stop: () => void
  try { stop = definition.watch!.start(owner, ...args) } catch (error) {
    replicaLog.warn({ model: name, error: String(error) }, `${name}: its change feed could not start`)
    stop = () => undefined
  }
  watches.set(id, { users: 1, stop })
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
  const hash = hashKey(key)
  writes.set(hash, (writes.get(hash) ?? 0) + 1)
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

const switchListeners = new Set<(id: string | null) => void>()

/**
 * Hear the account change (another person signed in, or a real sign-out), as the replica judges it: the one rule for what
 * belongs to an account (`createSelectStore(…, { scope: 'account' })`, an execution bound to the person who started it).
 * ❌ A second copy of "is this really another person".
 */
export function onAccountChange(listener: (id: string | null) => void): () => void {
  switchListeners.add(listener)
  return () => { switchListeners.delete(listener) }
}

function setAccount(next: AccountState): void {
  if (next.id === account.id && next.live === account.live) return
  const switched = next.id !== account.id
  account = next
  try {
    if (next.id) localStorage.setItem(LAST_ACCOUNT_KEY, next.id)
    else localStorage.removeItem(LAST_ACCOUNT_KEY)
  } catch { /* the pointer only speeds up the next start */ }
  accountListeners.forEach((listener) => listener())
  if (switched) switchListeners.forEach((listener) => listener(next.id))
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

type SnapshotEntry = { key: QueryKey; value: unknown; at: number }
type Snapshot = Record<string, SnapshotEntry>
type Limits = NonNullable<Definition<unknown[], unknown>['persist']>

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

function writeSnapshotEntry(key: QueryKey, value: unknown, at: number, limits: Limits): void {
  const owner = String(key[1])
  if (owner !== DEVICE && owner !== account.id) return
  const name = String(key[0])
  const snapshot = readSnapshot(owner)
  // Entries are dropped by age: models load with their chunks, so "not registered yet" is not "gone". A model whose
  // value changes shape takes a new name; its old entries age out here.
  for (const [hash, entry] of Object.entries(snapshot)) {
    if (!(entry?.at > Date.now() - SNAPSHOT_MAX_AGE_MS)) delete snapshot[hash]
  }
  const entry: SnapshotEntry = { key, value, at }
  const bytes = JSON.stringify(entry).length
  if (bytes > limits.maxBytes) {
    // Over its declared size: the older copy is not kept either, so the next start reads it as unknown.
    delete snapshot[hashKey(key)]
    refuseSnapshotWrite(name, `entry is ${bytes} B, its limit ${limits.maxBytes} B`)
  } else {
    snapshot[hashKey(key)] = entry
    const own = Object.entries(snapshot).filter(([, kept]) => kept.key[0] === name).sort(([, x], [, y]) => y.at - x.at)
    for (const [hash] of own.slice(limits.maxEntries)) delete snapshot[hash]
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
  const { maxBytes, maxEntries } = definition.persist
  return entries.filter((entry) => JSON.stringify(entry).length <= maxBytes).sort((x, y) => y.at - x.at).slice(0, maxEntries)
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
  const dropped: SnapshotEntry[] = []
  for (const [name, entries] of ownEntries(snapshot, owner)) {
    const definition = definitions.get(name)
    const keep = definition ? admitted(definition, entries) : entries
    dropped.push(...entries.filter((entry) => !keep.includes(entry)))
    for (const entry of keep) {
      if (queryClient.getQueryData(entry.key) === undefined) restoreEntry(entry.key, entry.value, entry.at)
    }
  }
  dropFromSnapshot(owner, snapshot, dropped)
}

/** A model registering for the first time: its kept entries it does not admit leave the cache and the snapshot. */
function pruneSnapshot(definition: Definition<unknown[], unknown>): void {
  for (const owner of definition.scope === DEVICE ? [DEVICE] : account.id ? [account.id] : []) {
    const snapshot = readSnapshot(owner)
    const entries = ownEntries(snapshot, owner).get(definition.name) ?? []
    const keep = admitted(definition, entries)
    const dropped = entries.filter((entry) => !keep.includes(entry))
    // Seeded from the snapshot: nothing of this model was read before it was defined.
    for (const entry of dropped) queryClient.removeQueries({ queryKey: entry.key, exact: true })
    dropFromSnapshot(owner, snapshot, dropped)
  }
}

function dropFromSnapshot(owner: string, snapshot: Snapshot, dropped: SnapshotEntry[]): void {
  if (dropped.length === 0) return
  for (const entry of dropped) delete snapshot[hashKey(entry.key)]
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot))
  } catch (error) {
    refuseSnapshotWrite(String(dropped[0]!.key[0]), `storage refused the ${owner === DEVICE ? 'device' : 'account'} block (${String(error)})`)
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
  /** Whether a surface shows this entry now (a read that fails for nobody needs no more work to say why). */
  isShown(...args: A): boolean
  /** Drop what is shown for these arguments (unknown again) and read again where it is shown; never throws. */
  reset(...args: A): Promise<void>
  /** Keep this entry's `watch` feed running as a surface would, for a reader that peeks without showing. Returns the release. */
  hold(...args: A): () => void
  /** @internal */ options(key: QueryKey): object
}

export type Entry<A extends unknown[], V> = { args: A; reading: Reading<V>; fetching: boolean }

/** An argument left out matches any value in its place (❌ dropped, which would shift the ones after it left). */
const argsMatch = (queryKey: QueryKey, args: readonly unknown[]) =>
  args.every((arg, index) => arg === undefined || hashKey([queryKey[index + 2]]) === hashKey([arg]))

/** The entries of a model for an owner whose arguments match. */
const matching = (definition: Definition<unknown[], unknown>, owner: string, args: readonly unknown[]) =>
  ({ queryKey: [definition.name, owner], predicate: (query: { queryKey: QueryKey }) => argsMatch(query.queryKey, args) })

/** Mark stale and read again where shown. */
async function refreshWhere(definition: Definition<unknown[], unknown>, filters: { queryKey: QueryKey; exact?: boolean; predicate?: (query: Query) => boolean }): Promise<void> {
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
}

/** One function per entry: a reading's `retry` keeps its identity across renders (a memoised child is not redrawn for it). */
const retries = new Map<string, Retry>()
function retryOfKey(key: QueryKey): Retry {
  const hash = hashKey(key)
  let retry = retries.get(hash)
  if (!retry) {
    retry = () => refreshWhere(definitions.get(String(key[0]))!, { queryKey: key, exact: true })
    retries.set(hash, retry)
  }
  return retry
}

/**
 * Read again every model of a group (`tags`), for the owner each is scoped to; arguments as `refresh` (left out = any).
 * The one fan-out: ❌ a function per feature that lists the models to refresh.
 */
export async function refreshTag(tag: string, ...args: unknown[]): Promise<void> {
  // Each through its own `refresh` (one path: what a model's refresh does, a tag does).
  await Promise.all([...models.values()].filter((model) => definitions.get(model.name)?.tags?.includes(tag)).map((model) => model.refresh(...args)))
}

/** The models defined, by name (the latest definition of a name serves, as `definitions`). */
const models = new Map<string, Replica<unknown[], unknown>>()

/** `refreshTag` each time `subscribe` fires (an event, a push); returns its stop. For a `watch.start` or a module's wiring. */
export function refreshTagOn(tag: string, subscribe: (fire: () => void) => () => void, ...args: unknown[]): () => void {
  return subscribe(() => { void refreshTag(tag, ...args) })
}

function ownerOf(scope: Scope): string | null {
  return scope === DEVICE ? DEVICE : account.id
}

export function replica<A extends unknown[], V>(definition: Definition<A, V>): Replica<A, V> {
  // A module evaluated again (hot reload, a test's module reset) defines its model again: the latest reader serves.
  const first = !definitions.has(definition.name)
  definitions.set(definition.name, definition as Definition<unknown[], unknown>)
  if (first) pruneSnapshot(definition as Definition<unknown[], unknown>)
  queryClient.setQueryDefaults([definition.name], { gcTime: definition.keep ?? Infinity })
  const options = (key: QueryKey) => ({
    queryKey: key,
    staleTime: definition.fresh ?? 0,
    gcTime: definition.keep ?? Infinity,
    retry: typeof definition.retry === 'function' ? retryPolicyOf(definition.retry, key) : definition.retry ?? false,
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
    return queryKey[0] === definition.name && !!owner && queryKey[1] === owner && argsMatch(queryKey, args)
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
  const model: Replica<A, V> = {
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
    // Async throughout: no signed-in account is a rejected read (a caller's `.catch` hears it), ❌ a throw before the promise.
    fetch: async (...args) => queryClient.fetchQuery(options(requireKey(args))) as Promise<V>,
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
    isShown: (...args) => {
      const k = key(...args)
      return !!k && (queryClient.getQueryCache().find({ queryKey: k, exact: true })?.getObserversCount() ?? 0) > 0
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
      if (owner) await refreshWhere(definition as Definition<unknown[], unknown>, matching(definition as Definition<unknown[], unknown>, owner, args))
    },
  }
  models.set(definition.name, model as unknown as Replica<unknown[], unknown>)
  return model
}

/** react-query asks the interval and the retry of the query; a definition asks them of the value shown, the failure and its arguments. */
function refetchIntervalOf<A extends unknown[], V>(every: number | ((value: V | undefined, error: Error | null, ...args: A) => number | false), key: QueryKey) {
  return typeof every === 'number' ? every
    : (query: { state: { data: unknown; error: Error | null } }) => every(query.state.data as V | undefined, query.state.error, ...(key.slice(2) as A))
}
function retryPolicyOf<A extends unknown[]>(retry: (failures: number, error: Error, ...args: A) => boolean, key: QueryKey) {
  return (failures: number, error: Error) => retry(failures, error, ...(key.slice(2) as A))
}

function readingOfState(state: { data: unknown; error: Error | null; status: string } | undefined, stale: boolean, key: QueryKey): Reading<never> {
  if (!state) return UNKNOWN
  // A failed refresh being retried is not said yet: a transient failure recovers silently; it is said once the retries are spent.
  if (state.data !== undefined) return { state: 'value', value: state.data as never, stale, error: state.error, retry: retryOfKey(key) }
  const error = state.error ?? lastFailure.get(hashKey(key))
  return error ? { state: 'error', error, retry: retryOfKey(key) } : UNKNOWN
}

function readingOf<V>(result: UseQueryResult<V>, key: QueryKey): Reading<V> {
  if (result.data !== undefined) return { state: 'value', value: result.data, stale: result.isStale, error: result.error, retry: retryOfKey(key) }
  const error = result.error ?? lastFailure.get(hashKey(key))
  return error ? { state: 'error', error, retry: retryOfKey(key) } : UNKNOWN
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
