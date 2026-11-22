import { getRendererSession, observeRendererSession } from '../sessionPublication'
import { onAccountChange, replicaAccount } from '../replica'
import { createOutbox, type Outbox, type OutboxAccount, type OutboxKind } from './core'
import { openOutboxStorage } from './storage'

export * from './core'

/**
 * The person the outbox drains for, as the replica judges it (the last account until the session is restored; only a
 * real change of person or a sign-out moves it). A session that is merely absent keeps the rows and pauses sending,
 * because `credential` is null.
 */
const rendererAccount: OutboxAccount = {
  current: () => replicaAccount().id,
  onChange: (listener) => onAccountChange(listener),
  credential: () => getRendererSession()?.user.id ?? null,
}

const KEY = '__GUGU_OUTBOX__'

/**
 * The window's one outbox: one drainer per renderer (a single window holds the instance lock). Kept on the window, so the
 * embedded session-page bundle enqueues into the same one instead of draining beside it.
 */
export function outbox(): Outbox {
  const host = globalThis as unknown as Record<string, Outbox | undefined>
  if (host[KEY]) return host[KEY]
  const created = host[KEY] = createOutbox({ storage: openOutboxStorage(), account: rendererAccount })
  // Credentials back (a refresh that reached the network again): what paused for them goes now.
  observeRendererSession(({ session }) => { if (session) created.kick() })
  return created
}

/** A kind with no account-scoped state (read positions, App notices): registered once, by whoever writes first or by the host. */
export function ensureKind<P, R>(box: Outbox, kind: OutboxKind<P, R>): void {
  if (!box.registered(kind.name)) box.register(kind)
}
