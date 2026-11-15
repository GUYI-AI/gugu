import { QueryClient, hashKey, useQueries, useQuery, type QueryFunctionContext, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
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
  /**
   * `stale`: a newer answer may be on its way (snapshot from an earlier run, or past `fresh`). `error`: the last refresh
   * failed, or the one being retried did (a model with `retry` says so while it retries).
   */
  | { state: 'value'; value: V; stale: boolean; error: Error | null }
  | { state: 'error'; error: Error }

export const UNKNOWN: Reading<never> = { state: 'unknown' }

type Scope = 'account' | 'device'

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
     * What of a value is carried across restarts (default: all of it). Whole fields left out, or `undefined` = this key is
     * not kept by definition (not a refusal); never a value cut short or rewritten. A field left out must be one the
     * value's type already has as optional and every reader already reads as "not known yet". The limits apply to what
     * is carried. Applied again to what a snapshot holds when it is restored, so it must give the same answer twice.
     */
    carry?: (value: V, ...args: A) => V | undefined
  }
  /** Read again when the window comes back to the foreground and the value is past `fresh`. */
  refreshOnFocus?: boolean
  /** `refresh` shares a read already on its way instead of cancelling it (for reads that are retried and polled). */
  refreshJoinsRead?: boolean
  /** Read again this often while a surface shows it (ms); a function of the value shown decides per value (false = not now). */
  refreshEvery?: number | ((value: V | undefined) => number | false)
  /** How many times a failed read is retried before the reading is an error. Default 0: fail loud. */
  retry?: number | true
  retryDelay?: (attempt: number) => number
  /**
   * A first source on this device (the IM library's own copy): asked once when a key is first wanted, its answer shows
   * (stale) until the read lands. ❌ A second snapshot of `persist`: this is data the app keeps anyway. Answered at once
   * (not a promise), it is there for the surface's first frame.
   */
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
queryClient.mount()
queryClient.getQueryCache().subscribe((event) => {
  const name = String(event.query.queryKey[0])
  if (event.type === 'added' && definitions.has(name) && event.query.options.queryFn !== readFromKey) {
    throw new Error(`Replica query ${JSON.stringify(event.query.queryKey)} brings its own queryFn`)
  }
  if (event.type === 'added') seedFromLocal(event.query.queryKey)
  const persist = definitions.get(name)?.persist
  if (event.type === 'updated' && event.action.type === 'success' && persist) {
    writeSnapshotEntry(event.query.queryKey, event.query.state.data, event.query.state.dataUpdatedAt, persist)
  }
  if (event.type === 'observerAdded' && persist) noteUse(event.query.queryKey)
})

/**
 * Put a value under a key, the entry living as long as its model keeps it (the account's lifetime by default) — ❌
 * react-query's five minutes for an entry nobody watches yet: a snapshot restored at start, or a value a write returned,
 * must still be there when a surface opens later. A model not registered yet (its chunk loads later) is kept likewise.
 */
function putValue(key: QueryKey, value: unknown): void {
  const next = typeof value === 'function' ? (value as (old: unknown) => unknown)(queryClient.getQueryData(key)) : value
  if (next !== undefined) putEntry(key, next)
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
  // Dated 0: shown as stale, and the read already on its way (or the next mount) replaces it.
  const put = (value: unknown) => { if (value !== undefined && queryClient.getQueryData(key) === undefined) putEntry(key, value, 0) }
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

/**
 * The account follows the published session. Only a real sign-out or another person signing in clears; a session that is
 * merely absent (boot restore, inactive shell, a refresh that cannot reach the network) holds — the devices cache learned
 * that the hard way twice (devicesCache.ts).
 */
export function followRendererSession(event: string, userId: string | null): void {
  if (userId) {
    if (account.id && account.id !== userId) forgetAccount(account.id)
    if (account.id !== userId) hydrateSnapshot(userId)
    setAccount({ id: userId, live: true })
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
type Limits = NonNullable<Definition<unknown[], unknown>['persist']>

/** An entry a surface shows right now counts as used now; otherwise when one last showed it (or when it was first kept). */
function lastUse(entry: SnapshotEntry, now: number): number {
  const shown = (queryClient.getQueryCache().find({ queryKey: entry.key, exact: true })?.getObserversCount() ?? 0) > 0
  return shown ? now : entry.used ?? entry.at
}

const USE_NOTED_EVERY_MS = 60_000
const usesNoted = new Map<string, number>()

/** A surface started showing a kept entry: record it, so eviction keeps what is used, ❌ what was read last. */
function noteUse(key: QueryKey): void {
  const owner = String(key[1])
  if (owner !== DEVICE && owner !== account.id) return
  const hash = hashKey(key)
  const now = Date.now()
  if (now - (usesNoted.get(hash) ?? 0) < USE_NOTED_EVERY_MS) return
  usesNoted.set(hash, now)
  const snapshot = readSnapshot(owner)
  const entry = snapshot[hash]
  if (!entry) return
  entry.used = now
  try { localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot)) } catch { /* a use not recorded only weakens the next eviction */ }
}
type Snapshot = Record<string, SnapshotEntry>

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
  const entry: SnapshotEntry = { key, value, at, used: snapshot[hash]?.used ?? now }
  const bytes = JSON.stringify(entry).length
  if (bytes > limits.maxBytes) {
    // Over its declared size: the older copy is not kept either, so the next start reads it as unknown.
    delete snapshot[hash]
    refuseSnapshotWrite(name, `entry is ${bytes} B, its limit ${limits.maxBytes} B`)
  } else {
    snapshot[hash] = entry
    // The least recently used leave (❌ the least recently read: a row read in the background must not push out one a
    // surface shows at every start).
    const own = Object.entries(snapshot).filter(([, kept]) => kept.key[0] === name).sort(([, x], [, y]) => lastUse(y, now) - lastUse(x, now))
    for (const [evicted] of own.slice(limits.maxEntries)) delete snapshot[evicted]
  }
  try {
    localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot))
  } catch (error) {
    refuseSnapshotWrite(name, `storage refused the ${owner === DEVICE ? 'device' : 'account'} block (${String(error)})`)
  }
}

/**
 * What a model as defined now admits of its kept entries: none without `persist`, each within `maxBytes`, the newest
 * `maxEntries`. A snapshot written by an older build (a model that no longer persists, a limit that shrank) goes no
 * further than this.
 */
function admitted(definition: Definition<unknown[], unknown>, entries: SnapshotEntry[]): SnapshotEntry[] {
  if (!definition.persist) return []
  const { maxBytes, maxEntries, carry } = definition.persist
  const now = Date.now()
  return entries
    .filter((entry) => !carry || carry(entry.value, ...entry.key.slice(2)) !== undefined)
    .filter((entry) => JSON.stringify(entry).length <= maxBytes)
    .sort((x, y) => lastUse(y, now) - lastUse(x, now))
    .slice(0, maxEntries)
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

/**
 * Seed the cache with the last run's values, dated when they were read, so `fresh` decides whether to read again. A model
 * not registered yet (it loads with its chunk) is seeded as kept and judged when it registers (`pruneSnapshot`).
 */
function hydrateSnapshot(owner: string): void {
  const snapshot = readSnapshot(owner)
  const dropped: SnapshotEntry[] = []
  for (const [name, entries] of ownEntries(snapshot, owner)) {
    const definition = definitions.get(name)
    const keep = definition ? admitted(definition, entries) : entries
    dropped.push(...entries.filter((entry) => !keep.includes(entry)))
    for (const entry of keep) {
      if (queryClient.getQueryData(entry.key) === undefined) putEntry(entry.key, entry.value, entry.at)
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
  /** @internal */ options(key: QueryKey): object
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
    retry: definition.retry ?? false,
    ...(definition.retryDelay ? { retryDelay: definition.retryDelay } : {}),
    ...(definition.refreshEvery ? { refetchInterval: refetchIntervalOf(definition.refreshEvery) } : {}),
    refetchOnWindowFocus: definition.refreshOnFocus ?? false,
    ...(definition.merge ? { structuralSharing: (shown: unknown, next: unknown) => shown === undefined ? next : definition.merge!(shown as V, next as V) } : {}),
  })
  const key = (...args: A): QueryKey | null => {
    const owner = ownerOf(definition.scope)
    return owner ? [definition.name, owner, ...args] : null
  }
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
      return k ? readingOfState(queryClient.getQueryState(k), queryClient.getQueryCache().find({ queryKey: k, exact: true })?.isStaleByTime(definition.fresh ?? 0) ?? true) : UNKNOWN
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
    refresh: async (...args) => {
      const owner = ownerOf(definition.scope)
      if (!owner) return
      // An argument left out matches any value in its place (❌ dropped, which would shift the ones after it left).
      const filters = {
        queryKey: [definition.name, owner],
        predicate: (query: { queryKey: QueryKey }) => args.every((arg, index) => arg === undefined || hashKey([query.queryKey[index + 2]]) === hashKey([arg])),
      }
      // A first read already on its way began before what this refresh announces, and react-query folds the refresh into
      // it (there is no value to keep meanwhile): read once more when it lands. A later read is cancelled and read again.
      const firstReads = queryClient.getQueryCache().findAll(filters)
        .filter((query) => query.state.fetchStatus !== 'idle' && query.state.data === undefined)
      await queryClient.invalidateQueries(filters, { cancelRefetch: !definition.refreshJoinsRead })
      await Promise.all(firstReads.map((query) => query.promise?.catch(() => undefined)
        .then(() => queryClient.refetchQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }))))
    },
  }
}

/** react-query asks the interval of the query; a definition asks it of the value shown. */
function refetchIntervalOf<V>(every: number | ((value: V | undefined) => number | false)) {
  return typeof every === 'number' ? every : (query: { state: { data: unknown } }) => every(query.state.data as V | undefined)
}

function readingOfState(state: { data: unknown; error: Error | null; fetchFailureReason: Error | null; status: string } | undefined, stale: boolean): Reading<never> {
  if (!state) return UNKNOWN
  // While a failed refresh is retried, the failure is said already (react-query keeps `error` empty until it gives up).
  if (state.data !== undefined) return { state: 'value', value: state.data as never, stale, error: state.error ?? state.fetchFailureReason }
  if (state.error) return { state: 'error', error: state.error }
  return UNKNOWN
}

function readingOf<V>(result: UseQueryResult<V>): Reading<V> {
  if (result.data !== undefined) return { state: 'value', value: result.data, stale: result.isStale, error: result.error ?? result.failureReason }
  if (result.error) return { state: 'error', error: result.error }
  return UNKNOWN
}

const IDLE_KEY = ['read-model:idle'] as const

/**
 * The reading for these arguments. `null` arguments = nothing to read yet (no subject): `unknown`, nothing requested.
 * Account models read only while the account's session is live; until then a snapshot from the last run is shown as is.
 */
export function useReplica<A extends unknown[], V>(model: Replica<A, V>, args: A | null, options: { read?: boolean } = {}): Reading<V> {
  const current = useSyncExternalStore(subscribeAccount, accountSnapshot)
  const definition = definitions.get(model.name)!
  const k = args ? model.key(...args) : null
  // `read: false`: show what is there (a snapshot, another reader's value) without asking yet.
  const canRead = !!k && options.read !== false && (definition.scope === DEVICE || current.live)
  const result = useQuery({ ...(model.options(k ?? IDLE_KEY) as { queryKey: QueryKey }), enabled: canRead }, queryClient) as UseQueryResult<V>
  return k ? readingOf(result) : UNKNOWN
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
  return results.map((result, index) => (keys[index] ? readingOf(result) : UNKNOWN))
}

/** Test seam: the live session as the replica sees it. */
export function replicaAccount(): AccountState { return account }

