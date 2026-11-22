// @@@outbox — the one outbox: every write this device asks the server (or a session host) to make goes through here,
// from the press of a button until it is confirmed. One durable table, keyed [accountId, id]; the id is the write's
// idempotency key, chosen at enqueue and never changed by a retry, a restart or another window.
//
// A kind declares only its own part: how to send (idempotently on the id), which lane orders it, how two writes of the
// same id merge. The rest is here, once:
//   · lanes run in parallel; inside a lane one write is in flight at a time, first in first out;
//   · a write that is queued, sending or backing off holds its lane; a failed or held one does not;
//   · merge happens at enqueue (a read position keeps the larger seq; a reaction keeps the last wish);
//   · one backoff (retries after 1 s, 4 s and 15 s, then failed) and one timeout per attempt (an AbortSignal);
//   · a write is bound to the account it was enqueued under: only that account's drain sends it, with that account's
//     credentials; another person signing in stops the drain and aborts what is in flight, the rows stay on disk;
//   · a failed write that could not reach its target is sent again on its own when the backend recovers, the browser
//     comes online, or its kind says its target became ready; a refused one waits for the person.
// Drain triggers: enqueue, ack, a backoff timer, those recovery signals. Nothing polls.

import { noteBackendRequestFailed, subscribeBackendRecovered } from '@gugu/core/cloud/backendReachability'
import { rendererLogger } from '../log'

export type OutboxState = 'queued' | 'sending' | 'waiting' | 'failed' | 'held'
/**
 * unreachable: the target did not answer (sent again automatically on recovery); rejected: the target refused it;
 * needs-file: the bytes are gone and must be chosen again; dependency: a write it depends on was discarded.
 */
export type OutboxFailureReason = 'unreachable' | 'rejected' | 'needs-file' | 'dependency'
export type OutboxFailure = { reason: OutboxFailureReason; message: string; code?: string }

export interface OutboxItem<P = unknown> {
  accountId: string
  id: string
  kind: string
  lane: string
  /** Lane order: max(now, previous + 1) at enqueue; a released held write takes a fresh one. */
  order: number
  /** Ids of other writes that must be confirmed first. */
  dependsOn: string[]
  payload: P
  state: OutboxState
  attempts: number
  retryAt?: number
  failure?: OutboxFailure
  /** Bumped by every enqueue merge or edit: a confirmation of an older payload does not remove a newer one. */
  rev: number
}

/** Thrown by a kind's send: the target refused the write; it fails at once and waits for the person. */
export class OutboxRejected extends Error {
  constructor(message: string, readonly reason: Exclude<OutboxFailureReason, 'unreachable'> = 'rejected', readonly code?: string) { super(message) }
}

/**
 * The server answered and refused this write: the same write gets the same answer, so it is not sent again on its own.
 * Judged from what the server said, not its wording: a Postgres SQLSTATE (PostgREST passes the database's own through)
 * refuses unless its class is transient (connection 08, rollback 40, resources 53, operator 57, system 58, internal XX,
 * lock not available 55P03); an HTTP status refuses when it is a 4xx other than 401, 408, 425 or 429. No answer, a 5xx or
 * PostgREST's own PGRST codes (its connection and credential failures) may differ next time. Looks through `cause`.
 */
export function refusedByServer(error: unknown): boolean {
  for (let value = error, depth = 0; value && typeof value === 'object' && depth < 4; value = (value as { cause?: unknown }).cause, depth += 1) {
    const { code, status } = value as { code?: unknown; status?: unknown }
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return !/^(08|40|53|57|58|XX)/.test(code) && code !== '55P03'
    if (typeof status === 'number' && status >= 400 && status < 500) return ![401, 408, 425, 429].includes(status)
  }
  return false
}

/** What a failed attempt says: refused (OutboxRejected, or the server's own refusal) or unreachable. */
export function failureOf(error: unknown): OutboxFailure {
  if (error instanceof OutboxRejected) return { reason: error.reason, message: error.message, ...(error.code ? { code: error.code } : {}) }
  return { reason: refusedByServer(error) ? 'rejected' : 'unreachable', message: error instanceof Error ? error.message : String(error) }
}

export class OutboxTimeout extends Error {
  constructor(seconds: number) { super(`No answer within ${seconds} s`) }
}

export interface OutboxKind<P = unknown, R = unknown> {
  name: string
  lane(payload: P): string
  /** Must be idempotent on item.id: the outbox sends again whenever the outcome is unknown. */
  send(item: OutboxItem<P>, signal: AbortSignal): Promise<R>
  merge?(previous: P, next: P): P
  /** Per-attempt deadline for send; null: none. Default 20 s. */
  timeoutMs?: number | null | ((item: OutboxItem<P>) => number | null)
  /**
   * Runs before each attempt, outside its deadline ("can it start" is not "did it answer"): the item to send this time
   * (a recipient resolved, a session made ready). Throwing fails the attempt like send.
   */
  prepare?(item: OutboxItem<P>): Promise<OutboxItem<P>>
  /** What a write whose dependency failed says (default: the dependency's own words). */
  blocked?(item: OutboxItem<P>, dependency: OutboxItem): string
  /** The target cannot take writes now (its host is offline): the lane waits for kick(kind) without spending an attempt. */
  ready?(item: OutboxItem<P>): boolean
  /** Failure for an error the send threw; default: failureOf. */
  failure?(error: unknown): OutboxFailure
  /** Durable completion before the row is removed (writing the confirmed message where it is read). */
  complete?(item: OutboxItem<P>, result: R): Promise<R>
  onState?(item: OutboxItem<P>): void
  onAck?(item: OutboxItem<P>, result: R): void
  onDiscard?(item: OutboxItem<P>): void
}

export interface OutboxStorage {
  list(accountId: string): Promise<OutboxItem[]>
  write(accountId: string, puts: readonly OutboxItem[], removes: readonly string[]): Promise<void>
}

/** Who is signed in. `change` fires only when the person changes (PR-A's account boundary). */
export interface OutboxAccount {
  current(): string | null
  onChange(listener: (accountId: string | null) => void): () => void
  /** The account whose credentials a request would carry right now. */
  credential(): string | null
}

export interface Outbox {
  register<P, R>(kind: OutboxKind<P, R>): () => void
  registered(name: string): boolean
  enqueue<P>(kind: string, payload: P, options?: { id?: string; dependsOn?: readonly string[]; hold?: boolean }): Promise<OutboxItem<P>>
  /** held → queued at the lane's end, optionally with a new payload. */
  release<P>(id: string, payload?: P): Promise<OutboxItem<P> | null>
  /** A queued, held or failed write's payload (not one in flight). */
  edit<P>(id: string, payload: P): Promise<OutboxItem<P> | null>
  /** failed → queued with a fresh attempt budget. */
  retry(id: string): Promise<void>
  discard(id: string): Promise<void>
  /** A kind fails one of its own writes (its bytes could not go up). */
  fail(id: string, failure: OutboxFailure): Promise<void>
  /** New lane order for these held writes, reusing their current order values. */
  reorder(ids: readonly string[]): Promise<void>
  get<P = unknown>(id: string): OutboxItem<P> | undefined
  items(): readonly OutboxItem[]
  subscribe(listener: () => void): () => void
  /** Resolves with the confirmation; rejects when it fails or is discarded. Resolves at once when nothing is pending. */
  settled<R = unknown>(id: string): Promise<R | undefined>
  /**
   * The target's first answer: resolves when the write is confirmed (or gone), rejects at its first failed attempt. For a
   * caller that tells the person right away (send now, mark all read); the write itself keeps its retries.
   */
  answered(id: string): Promise<void>
  /** A kind's target became ready: drain its lanes and send its unreachable failures again. */
  kick(kind?: string): void
  /** The account whose rows are loaded, once they are. */
  loaded(): Promise<string | null>
  accountId(): string | null
  dispose(): void
}

const log = rendererLogger('outbox')
// Owner's rule: three automatic retries, about 1 s, 4 s and 15 s apart; then the write shows as not sent (and is still
// sent again on its own when the network or its target comes back).
export const OUTBOX_BACKOFF_MS = [1_000, 4_000, 15_000] as const
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_BACKOFF_MS.length + 1
export const OUTBOX_TIMEOUT_MS = 20_000

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export function createOutbox(deps: {
  storage: OutboxStorage
  account: OutboxAccount
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  online?: (listener: () => void) => () => void
}): Outbox {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const kinds = new Map<string, OutboxKind>()
  const items = new Map<string, OutboxItem>()
  const inflight = new Map<string, AbortController>()
  // Rows whose discard is on its way to disk: nothing else may change, send or rewrite them meanwhile.
  const discarding = new Set<string>()
  const busy = new Set<string>()
  const timers = new Map<string, unknown>()
  const waiters = new Map<string, Set<Waiter>>()
  const listeners = new Set<() => void>()
  let account: string | null = null
  let generation = 0
  let lastOrder = 0
  let loading: Promise<string | null> = Promise.resolve(null)
  let writes: Promise<unknown> = Promise.resolve()
  let snapshot: readonly OutboxItem[] = []
  let disposed = false

  const publish = () => {
    snapshot = [...items.values()].sort((a, b) => a.order - b.order)
    for (const listener of [...listeners]) listener()
  }
  const settle = (id: string, outcome: { ok: true; value: unknown } | { ok: false; error: Error }) => {
    for (const waiter of waiters.get(id) ?? []) outcome.ok ? waiter.resolve(outcome.value) : waiter.reject(outcome.error)
    waiters.delete(id)
  }
  /** Writes keep their order on disk; a write that fails is logged loudly and reported to whoever awaits it. */
  const persist = (owner: string, puts: readonly OutboxItem[], removes: readonly string[] = []) => {
    const written = writes.catch(() => undefined).then(() => deps.storage.write(owner, puts, removes))
    writes = written
    void written.catch((error) => log.error({ error: String(error) }, 'outbox write failed'))
    return written
  }
  const current = (gen: number) => !disposed && gen === generation
  const kindOf = (item: OutboxItem) => kinds.get(item.kind)
  const notify = (item: OutboxItem) => {
    try { kindOf(item)?.onState?.(item) } catch (error) { log.error({ error: String(error), kind: item.kind }, 'outbox onState failed') }
  }
  /** Replace one row in memory and on disk, then tell its kind and the readers. */
  const put = (item: OutboxItem): Promise<void> => {
    if (discarding.has(item.id)) return Promise.resolve()
    items.set(item.id, item)
    publish()
    notify(item)
    return persist(item.accountId, [item])
  }

  async function load(next: string | null, gen: number): Promise<string | null> {
    if (!next) return null
    const rows = await deps.storage.list(next)
    if (!current(gen)) return account
    const restarted: OutboxItem[] = []
    for (const row of rows) {
      // A write that died in flight is sent again: the id makes the replay harmless. A start is itself a sign the target
      // may be back, so an unreachable failure from the last run goes again too (still shown failed until confirmed).
      const item = row.state === 'sending' ? { ...row, state: 'queued' as const }
        : row.state === 'failed' && row.failure?.reason === 'unreachable' && row.retryAt !== 0 ? { ...row, retryAt: 0 } : row
      if (item !== row) restarted.push(item)
      lastOrder = Math.max(lastOrder, item.order)
      items.set(item.id, { ...item, rev: item.rev ?? 0 })
    }
    if (restarted.length) await persist(next, restarted)
    publish()
    for (const item of items.values()) notify(item)
    pump()
    return next
  }

  function switchAccount(next: string | null): void {
    if (next === account && !disposed) return
    generation += 1
    for (const controller of inflight.values()) controller.abort(new Error('account changed'))
    inflight.clear()
    busy.clear()
    for (const timer of timers.values()) clearTimer(timer)
    timers.clear()
    for (const id of [...waiters.keys()]) settle(id, { ok: false, error: new Error('account changed') })
    items.clear()
    lastOrder = 0
    account = next
    publish()
    loading = load(next, generation).catch((error) => {
      log.error({ error: String(error) }, 'outbox rows could not be loaded')
      throw error
    })
  }

  // ── drain ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  function pump(): void {
    if (disposed || !account) return
    const lanes = new Set<string>()
    for (const item of items.values()) if (item.state !== 'held') lanes.add(item.lane)
    for (const lane of lanes) if (!busy.has(lane)) void runLane(lane, generation)
  }

  function schedule(lane: string, at: number): void {
    const previous = timers.get(lane)
    if (previous !== undefined) clearTimer(previous)
    timers.set(lane, setTimer(() => { timers.delete(lane); pump() }, Math.max(0, at - now())))
  }

  /** The write that goes next in this lane, or why nothing can go now. */
  function head(lane: string): OutboxItem | null {
    const rows = [...items.values()].filter((item) => item.lane === lane).sort((a, b) => a.order - b.order)
    for (const item of rows) {
      if (item.state === 'held' || discarding.has(item.id)) continue
      if (item.state === 'failed') {
        // Unreachable failures go again only when something says the target is back (retryAt cleared by a trigger).
        if (item.failure?.reason === 'unreachable' && item.retryAt === 0) return item
        continue
      }
      if (item.state === 'waiting' && (item.retryAt ?? 0) > now()) { schedule(lane, item.retryAt!); return null }
      return item
    }
    return null
  }

  async function runLane(lane: string, gen: number): Promise<void> {
    busy.add(lane)
    try {
      for (;;) {
        if (!current(gen)) return
        const item = head(lane)
        if (!item) return
        const kind = kindOf(item)
        if (!kind) return // registered later; register() pumps
        const blocker = item.dependsOn.map((id) => items.get(id)).find(Boolean)
        if (blocker) {
          if (item.state === 'failed') {
            // Sent again only after what it follows: back to not due, the dependency's confirmation pumps it.
            items.set(item.id, { ...item, retryAt: undefined })
            continue
          }
          if (blocker.state === 'failed') {
            await fail(item, { reason: blocker.failure?.reason === 'unreachable' || blocker.failure?.reason === 'dependency' ? blocker.failure.reason : 'rejected',
              message: kind.blocked?.(item, blocker) ?? blocker.failure?.message ?? 'A message it follows was not sent' }, gen)
            continue
          }
          return // the dependency's confirmation pumps again
        }
        if (kind.ready && !kind.ready(item)) return
        if (deps.account.credential() !== item.accountId) return
        await attempt(item, kind, gen)
      }
    } catch (error) {
      log.error({ error: String(error), lane }, 'outbox lane stopped')
    } finally {
      if (current(gen)) busy.delete(lane)
    }
  }

  async function fail(item: OutboxItem, failure: OutboxFailure, gen: number): Promise<void> {
    if (!current(gen) || !items.has(item.id)) return
    const failed: OutboxItem = { ...item, state: 'failed', failure, retryAt: undefined }
    await put(failed)
    settle(item.id, { ok: false, error: new Error(failure.message) })
  }

  async function attempt(item: OutboxItem, kind: OutboxKind, gen: number): Promise<void> {
    const background = item.state === 'failed'
    // A failed write being sent again in the background keeps showing failed until it is confirmed.
    const sending: OutboxItem = background ? { ...item, retryAt: undefined } : { ...item, state: 'sending', retryAt: undefined }
    if (background) { items.set(item.id, sending); publish() } else await put(sending)
    const controller = new AbortController()
    inflight.set(item.id, controller)
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
    aborted.catch(() => undefined)
    let timer: unknown, result: unknown, error: unknown, ok = false
    try {
      const prepared = kind.prepare ? await Promise.race([kind.prepare(sending), aborted]) : sending
      const timeoutMs = typeof kind.timeoutMs === 'function' ? kind.timeoutMs(prepared) : kind.timeoutMs === undefined ? OUTBOX_TIMEOUT_MS : kind.timeoutMs
      if (timeoutMs !== null) timer = setTimer(() => controller.abort(new OutboxTimeout(timeoutMs / 1000)), timeoutMs)
      result = await Promise.race([Promise.resolve().then(() => kind.send(prepared, controller.signal)), aborted])
      if (kind.complete && current(gen) && items.get(item.id)?.rev === sending.rev) result = await Promise.race([kind.complete(sending, result), aborted])
      ok = true
    } catch (thrown) {
      error = thrown
    } finally {
      if (timer !== undefined) clearTimer(timer)
      if (inflight.get(item.id) === controller) inflight.delete(item.id)
    }
    if (!current(gen)) return
    const live = items.get(item.id)
    if (!live) return // discarded while in flight
    if (ok) {
      if (live.rev !== sending.rev) {
        // A newer payload merged in meanwhile: it is the one that must be confirmed now.
        await put({ ...live, state: 'queued', attempts: 0, failure: undefined, retryAt: undefined })
        return
      }
      items.delete(item.id)
      publish()
      await persist(item.accountId, [], [item.id])
      settle(item.id, { ok: true, value: result })
      try { kind.onAck?.(sending, result) } catch (ackError) { log.error({ error: String(ackError), kind: item.kind }, 'outbox onAck failed') }
      pump() // what waited for it, in other lanes
      return
    }
    const failure = kind.failure ? kind.failure(error) : failureOf(error)
    const attempts = live.attempts + 1
    log.warn({ kind: item.kind, id: item.id, attempts, reason: failure.reason, error: failure.message }, 'outbox write not confirmed')
    if (failure.reason !== 'unreachable' || background || attempts >= OUTBOX_MAX_ATTEMPTS) {
      if (failure.reason === 'unreachable') noteBackendRequestFailed() // if the backend is down, its recovery sends this again
      await fail({ ...live, attempts }, failure, gen)
      pump() // what waited for it fails with it
      return
    }
    const retryAt = now() + OUTBOX_BACKOFF_MS[attempts - 1]
    await put({ ...live, state: 'waiting', attempts, failure, retryAt })
  }

  /** Recovery: everything waiting goes now, every unreachable failure goes again. */
  function recover(kind?: string): void {
    if (!account) return
    const due: OutboxItem[] = []
    for (const item of items.values()) {
      if (kind && item.kind !== kind) continue
      if (item.state === 'waiting' || item.state === 'failed' && item.failure?.reason === 'unreachable' && item.retryAt !== 0) {
        due.push({ ...item, retryAt: 0 })
      }
    }
    for (const item of due) items.set(item.id, item)
    if (due.length) publish()
    pump()
  }

  // ── public ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  const requireLoaded = async (): Promise<{ owner: string; gen: number }> => {
    const gen = generation
    const owner = await loading
    if (!owner || !current(gen) || owner !== account) throw new Error('No account is signed in for the outbox')
    return { owner, gen }
  }

  const stopAccount = deps.account.onChange((next) => switchAccount(next))
  const stopRecovered = subscribeBackendRecovered(() => recover())
  const stopOnline = (deps.online ?? ((listener) => {
    if (typeof window === 'undefined') return () => {}
    window.addEventListener('online', listener)
    return () => window.removeEventListener('online', listener)
  }))(() => recover())
  switchAccount(deps.account.current())

  return {
    register(kind) {
      if (kinds.has(kind.name)) throw new Error(`Outbox kind ${kind.name} is already registered`)
      kinds.set(kind.name, kind as OutboxKind) // stored erased: a kind only ever receives its own items
      for (const item of items.values()) if (item.kind === kind.name) notify(item)
      pump()
      return () => { if (kinds.get(kind.name) === kind) kinds.delete(kind.name) }
    },
    async enqueue(name, payload, options = {}) {
      const kind = kinds.get(name)
      if (!kind) throw new Error(`Outbox kind ${name} is not registered`)
      const { owner, gen } = await requireLoaded()
      const id = options.id ?? crypto.randomUUID()
      const previous = items.get(id)
      let item: OutboxItem
      if (previous) {
        if (previous.kind !== name) throw new Error(`Outbox id ${id} belongs to ${previous.kind}`)
        if (!kind.merge) throw new Error(`Outbox id ${id} is already queued`)
        const merged = kind.merge(previous.payload, payload)
        item = { ...previous, payload: merged, lane: kind.lane(merged), rev: previous.rev + 1,
          ...(previous.state === 'failed' || previous.state === 'waiting' ? { state: 'queued' as const, attempts: 0, failure: undefined, retryAt: undefined } : {}) }
      } else {
        lastOrder = Math.max(now(), lastOrder + 1)
        item = { accountId: owner, id, kind: name, lane: kind.lane(payload), order: lastOrder, dependsOn: [...options.dependsOn ?? []],
          payload, state: options.hold ? 'held' : 'queued', attempts: 0, rev: 0 }
      }
      // Durable first: a write the disk did not take is not accepted, and nothing in memory says otherwise.
      await persist(owner, [item])
      if (!current(gen)) throw new Error('The account changed before the write was queued')
      items.set(id, item)
      publish()
      notify(item)
      pump()
      return item as OutboxItem<never>
    },
    async release(id, payload) {
      const item = items.get(id)
      if (!item || item.state !== 'held' || discarding.has(id)) return null
      lastOrder = Math.max(now(), lastOrder + 1)
      const released: OutboxItem = { ...item, state: 'queued', order: lastOrder, rev: item.rev + 1,
        ...(payload === undefined ? {} : { payload, lane: kindOf(item)?.lane(payload) ?? item.lane }) }
      await put(released)
      pump()
      return released as OutboxItem<never>
    },
    async edit(id, payload) {
      const item = items.get(id)
      if (!item || item.state === 'sending' || inflight.has(id) || discarding.has(id)) return null
      const edited: OutboxItem = { ...item, payload, lane: kindOf(item)?.lane(payload) ?? item.lane, rev: item.rev + 1 }
      await put(edited)
      pump()
      return edited as OutboxItem<never>
    },
    async retry(id) {
      const item = items.get(id)
      if (!item || item.state !== 'failed' || discarding.has(id)) return
      await put({ ...item, state: 'queued', attempts: 0, failure: undefined, retryAt: undefined })
      pump()
    },
    async discard(id) {
      const item = items.get(id)
      if (!item || discarding.has(id)) return
      const failure: OutboxFailure = { reason: 'dependency', message: 'A message it follows was discarded' }
      const failedDependents = () => [...items.values()].filter((row) => row.id !== id && row.dependsOn.includes(id))
        .map((row) => ({ ...row, state: 'failed' as const, failure, retryAt: undefined }))
      // On disk first: a discard the disk did not take must not come back after a restart and be sent. Meanwhile the row
      // is out of reach: not sent, not edited, not committed.
      discarding.add(id)
      inflight.get(id)?.abort(new Error('discarded'))
      try { await persist(item.accountId, failedDependents(), [id]) }
      catch (error) { discarding.delete(id); pump(); throw error }
      discarding.delete(id)
      items.delete(id)
      const failed = failedDependents()
      for (const row of failed) items.set(row.id, row)
      publish()
      settle(id, { ok: false, error: new Error('discarded') })
      for (const row of failed) { notify(row); settle(row.id, { ok: false, error: new Error(failure.message) }) }
      try { kindOf(item)?.onDiscard?.(item) } catch (error) { log.error({ error: String(error), kind: item.kind }, 'outbox onDiscard failed') }
      pump()
    },
    async fail(id, failure) {
      const item = items.get(id)
      if (item) await fail(item, failure, generation)
      pump()
    },
    async reorder(ids) {
      const rows = ids.map((id) => items.get(id))
      if (rows.some((row) => !row || row.state !== 'held')) throw new Error('Only held writes can be reordered')
      const orders = rows.map((row) => row!.order).sort((a, b) => a - b)
      const moved = rows.map((row, index) => ({ ...row!, order: orders[index]! }))
      for (const row of moved) items.set(row.id, row)
      publish()
      for (const row of moved) notify(row)
      if (moved.length) await persist(moved[0]!.accountId, moved)
    },
    registered: (name) => kinds.has(name),
    get: (id) => items.get(id) as OutboxItem<never> | undefined,
    items: () => snapshot,
    subscribe: (listener) => (listeners.add(listener), () => { listeners.delete(listener) }),
    settled(id) {
      const item = items.get(id)
      if (!item) return Promise.resolve(undefined)
      if (item.state === 'failed') return Promise.reject(new Error(item.failure?.message ?? 'not sent'))
      return new Promise((resolve, reject) => {
        waiters.set(id, (waiters.get(id) ?? new Set()).add({ resolve: resolve as (value: unknown) => void, reject }))
      })
    },
    answered(id) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const item = items.get(id)
          if (item && !item.failure) return
          stop()
          if (item) reject(new Error(item.failure!.message)); else resolve()
        }
        const stop = (listeners.add(check), () => { listeners.delete(check) })
        check()
      })
    },
    kick: (kind) => recover(kind),
    loaded: () => loading,
    accountId: () => account,
    dispose() {
      if (disposed) return
      switchAccount(null)
      disposed = true
      stopAccount(); stopRecovered(); stopOnline()
    },
  }
}
