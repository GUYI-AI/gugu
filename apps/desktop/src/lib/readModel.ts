import { QueryClient, hashKey, useQueries, useQuery, type QueryFunctionContext, type QueryKey, type UseQueryResult } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { observeRendererSession } from './sessionPublication'

/**
 * @@@read-model — one read model per kind of data a surface shows (open-flicker, owner 2026-11-14).
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
  /** `stale`: a newer answer may be on its way (snapshot from an earlier run, or past `fresh`). `error`: the last refresh failed. */
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
  /** Keep the last value across restarts (localStorage). Display values only: never tokens or credentials. */
  persist?: boolean
  /** Read again when the window comes back to the foreground and the value is past `fresh`. */
  refreshOnFocus?: boolean
  /** `refresh` shares a read already on its way instead of cancelling it (for reads that are retried and polled). */
  refreshJoinsRead?: boolean
  /** Read again this often while a surface shows it (ms). */
  refreshEvery?: number
  /** How many times a failed read is retried before the reading is an error. Default 0: fail loud. */
  retry?: number | true
  retryDelay?: (attempt: number) => number
}

const definitions = new Map<string, Definition<unknown[], unknown>>()

const readFromKey = ({ queryKey }: QueryFunctionContext) => {
  const [name, owner, ...args] = queryKey as [string, string, ...unknown[]]
  const definition = definitions.get(name)
  if (!definition) throw new Error(`No read model named ${name}`)
  return definition.read(owner, ...args)
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { queryFn: readFromKey } } })
queryClient.mount()
queryClient.getQueryCache().subscribe((event) => {
  const name = String(event.query.queryKey[0])
  if (event.type === 'added' && definitions.has(name) && event.query.options.queryFn !== readFromKey) {
    throw new Error(`Read model query ${JSON.stringify(event.query.queryKey)} brings its own queryFn`)
  }
  if (event.type === 'updated' && event.action.type === 'success' && definitions.get(name)?.persist) {
    writeSnapshotEntry(event.query.queryKey, event.query.state.data, event.query.state.dataUpdatedAt)
  }
})

// ── account lifecycle ────────────────────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_PREFIX = 'gugu.readModel.v1:'
const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 3600_000
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

type SnapshotEntry = { key: QueryKey; value: unknown; at: number }
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

function writeSnapshotEntry(key: QueryKey, value: unknown, at: number): void {
  const owner = String(key[1])
  if (owner !== DEVICE && owner !== account.id) return
  const snapshot = readSnapshot(owner)
  // Entries are dropped by age only: models load with their chunks, so "not registered yet" is not "gone". A model whose
  // value changes shape takes a new name; its old entries age out here.
  for (const [hash, entry] of Object.entries(snapshot)) {
    if (!(entry?.at > Date.now() - SNAPSHOT_MAX_AGE_MS)) delete snapshot[hash]
  }
  snapshot[hashKey(key)] = { key, value, at }
  try { localStorage.setItem(SNAPSHOT_PREFIX + owner, JSON.stringify(snapshot)) } catch { /* quota: the next start reads again */ }
}

/** Seed the cache with the last run's values, dated when they were read, so `fresh` decides whether to read again. */
function hydrateSnapshot(owner: string): void {
  for (const entry of Object.values(readSnapshot(owner))) {
    if (!Array.isArray(entry?.key) || entry.key[1] !== owner) continue
    if (queryClient.getQueryData(entry.key) !== undefined) continue
    queryClient.setQueryData(entry.key, entry.value, { updatedAt: entry.at })
  }
}

hydrateSnapshot(DEVICE)
if (account.id) hydrateSnapshot(account.id)

// ── models ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReadModel<A extends unknown[], V> = {
  readonly name: string
  /** The key for these arguments, or null while there is no account to read for. */
  key(...args: A): QueryKey | null
  /** What a surface opening now would show, synchronously. */
  peek(...args: A): Reading<V>
  /** Read now unless fresh; never throws (the error lands in the reading). */
  prefetch(...args: A): Promise<void>
  /** Read now unless fresh, and return the value. */
  fetch(...args: A): Promise<V>
  /** Put a value a write returned. */
  set(args: A, value: V | ((old: V | undefined) => V | undefined)): void
  /** Mark stale and read again where shown; without arguments, every entry of this model. */
  refresh(...args: Partial<A>): Promise<void>
  /** @internal */ options(key: QueryKey): object
}

function ownerOf(scope: Scope): string | null {
  return scope === DEVICE ? DEVICE : account.id
}

export function readModel<A extends unknown[], V>(definition: Definition<A, V>): ReadModel<A, V> {
  // A module evaluated again (hot reload, a test's module reset) defines its model again: the latest reader serves.
  definitions.set(definition.name, definition as Definition<unknown[], unknown>)
  const options = (key: QueryKey) => ({
    queryKey: key,
    staleTime: definition.fresh ?? 0,
    gcTime: definition.keep ?? Infinity,
    retry: definition.retry ?? false,
    ...(definition.retryDelay ? { retryDelay: definition.retryDelay } : {}),
    ...(definition.refreshEvery ? { refetchInterval: definition.refreshEvery } : {}),
    refetchOnWindowFocus: definition.refreshOnFocus ?? false,
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
      return k ? readingOfState(queryClient.getQueryState(k), queryClient.getQueryCache().find({ queryKey: k, exact: true })?.isStale() ?? true) : UNKNOWN
    },
    prefetch: (...args) => {
      const k = key(...args)
      return k ? queryClient.prefetchQuery(options(k)) : Promise.resolve()
    },
    fetch: (...args) => queryClient.fetchQuery(options(requireKey(args))) as Promise<V>,
    set: (args, value) => {
      queryClient.setQueryData<V>(requireKey(args), value as V | ((old: V | undefined) => V | undefined))
    },
    refresh: async (...args) => {
      const owner = ownerOf(definition.scope)
      if (!owner) return
      const filters = { queryKey: [definition.name, owner, ...args.filter((arg) => arg !== undefined)] }
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

function readingOfState(state: { data: unknown; error: Error | null; status: string } | undefined, stale: boolean): Reading<never> {
  if (!state) return UNKNOWN
  if (state.data !== undefined) return { state: 'value', value: state.data as never, stale, error: state.error }
  if (state.error) return { state: 'error', error: state.error }
  return UNKNOWN
}

function readingOf<V>(result: UseQueryResult<V>): Reading<V> {
  if (result.data !== undefined) return { state: 'value', value: result.data, stale: result.isStale, error: result.error }
  if (result.error) return { state: 'error', error: result.error }
  return UNKNOWN
}

const IDLE_KEY = ['read-model:idle'] as const

/**
 * The reading for these arguments. `null` arguments = nothing to read yet (no subject): `unknown`, nothing requested.
 * Account models read only while the account's session is live; until then a snapshot from the last run is shown as is.
 */
export function useReadModel<A extends unknown[], V>(model: ReadModel<A, V>, args: A | null, options: { read?: boolean } = {}): Reading<V> {
  const current = useSyncExternalStore(subscribeAccount, accountSnapshot)
  const definition = definitions.get(model.name)!
  const k = args ? model.key(...args) : null
  // `read: false`: show what is there (a snapshot, another reader's value) without asking yet.
  const canRead = !!k && options.read !== false && (definition.scope === DEVICE || current.live)
  const result = useQuery({ ...(model.options(k ?? IDLE_KEY) as { queryKey: QueryKey }), enabled: canRead }, queryClient) as UseQueryResult<V>
  return k ? readingOf(result) : UNKNOWN
}

/** One reading per subject (rows of a list), in the order given. */
export function useReadModels<A extends unknown[], V>(model: ReadModel<A, V>, argsList: readonly A[]): Reading<V>[] {
  const current = useSyncExternalStore(subscribeAccount, accountSnapshot)
  const definition = definitions.get(model.name)!
  const canRead = definition.scope === DEVICE || current.live
  const keys = argsList.map((args) => model.key(...args))
  const results = useQueries({
    queries: keys.map((k) => ({ ...(model.options(k ?? IDLE_KEY) as { queryKey: QueryKey }), enabled: !!k && canRead })),
  }, queryClient) as UseQueryResult<V>[]
  return results.map((result, index) => (keys[index] ? readingOf(result) : UNKNOWN))
}

/** Test seam: the live session as the read model sees it. */
export function readModelAccount(): AccountState { return account }

