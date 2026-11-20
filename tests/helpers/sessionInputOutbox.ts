// A real outbox (lib/outbox/core) with the sessionInput kind registered, installed as the window's one outbox, so the
// session-input API (enqueueSessionInput, releaseQueuedSessionInput, state().rows …) drives it exactly as in the app.
// Only the transport (send) and the disk (storage) are the test's.
import { createOutbox, type Outbox, type OutboxAccount, type OutboxItem, type OutboxStorage } from '@/lib/outbox/core'
import { EMPTY, changed, publishRows, sessionInputKind, state } from '@/lib/outbox/kinds/sessionInput'
import type { SessionInput } from '@/lib/sessionInput'

export function memoryOutboxStorage(): OutboxStorage & { rows: Map<string, OutboxItem> } {
  const rows = new Map<string, OutboxItem>()
  return {
    rows,
    list: async accountId => [...rows.values()].filter(row => row.accountId === accountId).map(row => structuredClone(row)),
    write: async (accountId, puts, removes) => {
      for (const item of puts) rows.set(`${accountId}/${item.id}`, structuredClone(item))
      for (const id of removes) rows.delete(`${accountId}/${id}`)
    },
  }
}

const KEY = '__GUGU_OUTBOX__'

export type InstalledSessionInputs = ReturnType<typeof installSessionInputOutbox>

/**
 * Only the core, installed as the window's one outbox for `accountId`; the app's own hosts (OutboxHost) register the kinds.
 * `setAccount` is another person signing in (the replica's onAccountChange).
 */
export function installOutboxCore(options: { accountId?: string; storage?: OutboxStorage } = {}) {
  let id: string | null = options.accountId ?? 'owner'
  let credential: string | null = id
  const listeners = new Set<(id: string | null) => void>()
  const account: OutboxAccount = {
    current: () => id,
    credential: () => credential,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const host = globalThis as unknown as Record<string, Outbox | undefined>
  host[KEY]?.dispose()
  const box = createOutbox({ storage: options.storage ?? memoryOutboxStorage(), account, online: () => () => {} })
  host[KEY] = box
  return {
    outbox: box,
    setAccount(next: string | null) { id = next; credential = next; for (const listener of [...listeners]) listener(next) },
    /** The session is absent (credentials gone) or back: the drain pauses, then goes on with a kick. */
    setCredential(next: string | null) { credential = next; if (next) box.kick() },
    dispose() { box.dispose(); if (host[KEY] === box) delete host[KEY] },
  }
}

export function installSessionInputOutbox(options: {
  send: (input: SessionInput) => Promise<void>
  prepare?: (input: SessionInput) => Promise<SessionInput>
  storage?: OutboxStorage
  accountId?: string
  valid?: () => boolean
}) {
  const accountId = options.accountId ?? 'owner'
  const core = installOutboxCore({ accountId, ...(options.storage ? { storage: options.storage } : {}) })
  const box = core.outbox
  const own = state()
  own.accountId = accountId
  own.rows = EMPTY
  own.valid = options.valid ?? (() => own.accountId === box.accountId())
  const stops = [box.register(sessionInputKind({ prepare: options.prepare ?? (async input => input), send: options.send })), box.subscribe(publishRows)]
  publishRows()
  return {
    outbox: box,
    rows: () => state().rows,
    /** Another person signs in: the outbox follows, the rows view follows the new account. */
    setAccount(next: string | null) {
      own.accountId = next
      core.setAccount(next)
      publishRows()
    },
    dispose() {
      for (const stop of stops) stop()
      core.dispose()
      own.accountId = null; own.rows = EMPTY; own.valid = () => false
      changed()
    },
  }
}

/** Lets queued promise work and storage callbacks run (macrotasks; not under fake setImmediate). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => typeof setImmediate === 'function' ? setImmediate(resolve) : setTimeout(resolve, 0))
  }
}
