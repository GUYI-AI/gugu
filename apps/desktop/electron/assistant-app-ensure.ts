// #1931 The product's assistant App (assistant-rules-trust.ts) is on every machine whose assistant needs it, without the
// person doing anything: a profile created before the App joined the first-run set never runs that set again, so this
// puts it in at start — in the background, silently (the log only), retried with backoff until it is in. Never a toast,
// a question or a button.
//
// Whether it is needed here is one fact, not a record of intent: the account signed in here has an assistant, wherever it
// lives (the App is the assistant's page on every machine the person opens it from: this computer, another one, the
// cloud, a server), the assistant lives on this machine (its home is here, or this is a cloud machine hosting it), or its
// setup started in this run. An App the person uninstalled stays out while they have no assistant here or anywhere; while
// they have one, it needs its page, so the App goes back in.
//
// "In" means a copy the host trusts is in, not that something holds its id (`assistantAppHere`). Two kinds of untrusted
// copy are told apart by what the person did, never by what the copy is:
// - the person's own: installed from anywhere but the market (a folder, a chat, a fork's source), a fork of it switched
//   on, or switched off. Left as it is — never put over, nothing said; the assistant keeps the last good copy of its rules;
// - gugu's market copy the host does not believe (an old unsigned build, its signed release not recorded, its files
//   changed): put over with the market's signed release, the way a missing App is put in. Once: a copy this step put in
//   that is still not believed is what the market gives, left until the next start.

/** A copy of the App installed here, as this step names it: the market install goes over that copy only. */
export interface AssistantAppCopy {
  version: string
  manifestDigest: string
}

/** What tells whose copy it is (origin undefined: an install a start cut off before its record — gugu's, put in again). */
export interface AssistantAppCopyHere extends AssistantAppCopy {
  origin: string | undefined
  activeVariant: string
  enabled: boolean
}

/**
 * The App with the assistant App's id here, to this step: `absent`; `trusted` (nothing to do); `own` — the person's, or one
 * gugu cannot read: never put over; `untrusted` — gugu's market copy the host does not believe: put over.
 */
export type AssistantAppHere =
  | { state: 'absent' }
  | { state: 'trusted' }
  | { state: 'own'; reason: string }
  | { state: 'untrusted'; reason: string; copy: AssistantAppCopy }

/** Why the copy here is the person's own choice, or null for gugu's market copy. */
export function personsOwnAssistantApp(copy: Pick<AssistantAppCopyHere, 'origin' | 'activeVariant' | 'enabled'>): string | null {
  if (copy.origin !== undefined && copy.origin !== 'market') return `it was installed from ${copy.origin}, not the market`
  if (copy.activeVariant !== 'upstream') return `its fork "${copy.activeVariant}" is switched on`
  if (!copy.enabled) return 'it is switched off'
  return null
}

/** The copy here to this step; `distrust` (the host's trust check, why it is not believed) is asked of gugu's copies only. */
export async function assistantAppHere(
  copy: AssistantAppCopyHere | null, distrust: () => string | null | Promise<string | null>,
): Promise<AssistantAppHere> {
  if (!copy) return { state: 'absent' }
  const own = personsOwnAssistantApp(copy)
  if (own) return { state: 'own', reason: own }
  const reason = await distrust()
  return reason ? { state: 'untrusted', reason, copy: { version: copy.version, manifestDigest: copy.manifestDigest } } : { state: 'trusted' }
}

export interface AssistantAppEnsureDeps {
  /** The App with the assistant App's id here (`assistantAppHere`). */
  installed(): AssistantAppHere | Promise<AssistantAppHere>
  /** Whether this machine needs it now (see above). */
  needed(): boolean | Promise<boolean>
  /**
   * Puts it in from the market as gugu's own (the market install with gugu's consent) — over `over`, gugu's untrusted
   * copy named as it was looked at, when there is one; throws what failed.
   */
  install(over: AssistantAppCopy | null): Promise<void>
  /** After it went in: the rules are read again. */
  afterInstall(): Promise<unknown>
  /** Waits between attempts; injected so tests do not wait. */
  sleep(ms: number): Promise<void>
  warn(message: string, detail: Record<string, unknown>): void
  info(message: string, detail: Record<string, unknown>): void
  /** Called once when every attempt of the backoff window failed: the one place a real failure may be said. */
  stuck?(error: string): void
}

/** The waits between attempts: about 20 minutes of trying before it counts as stuck, then every 10 minutes for good. */
export const ASSISTANT_APP_ENSURE_BACKOFF_MS: readonly number[] = [15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000]

/**
 * `present`: a trusted copy is in. `own`: the person's copy, left. `untrusted`: gugu's copy this step put in, still not
 * believed, left. `not-needed`. `installed`: put in now (or over gugu's untrusted copy).
 */
export type AssistantAppEnsureOutcome = 'present' | 'own' | 'untrusted' | 'not-needed' | 'installed'
export type AssistantAppEnsureReason = 'start' | 'setup' | 'assistant'

export interface AssistantAppEnsurer {
  /**
   * One go, joined by any call while it runs. `setup`: the assistant's setup started, so it is needed from now on.
   * `assistant`: a window found the account's assistant (anywhere) while no trusted App is in: is it needed now?
   */
  ensure(reason: AssistantAppEnsureReason): Promise<AssistantAppEnsureOutcome>
  /** Whether a setup asked for it in this run. */
  setupStarted(): boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function assistantAppEnsurer(deps: AssistantAppEnsureDeps, backoff: readonly number[] = ASSISTANT_APP_ENSURE_BACKOFF_MS): AssistantAppEnsurer {
  let running: Promise<AssistantAppEnsureOutcome> | null = null
  let setup = false
  /** The manifest digest of a copy this step put in that the host still did not believe: not put over again in this run. */
  let putInUntrusted: string | null = null

  async function run(): Promise<AssistantAppEnsureOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        const here = await deps.installed()
        if (here.state === 'trusted') return 'present'
        if (here.state === 'own') return 'own'
        if (here.state === 'untrusted' && here.copy.manifestDigest === putInUntrusted) return 'untrusted'
        if (!setup && !(await deps.needed())) return 'not-needed'
        if (here.state === 'untrusted') {
          deps.info('assistant App: the copy here is not trusted; the market\'s release goes over it', { attempt, version: here.copy.version, reason: here.reason })
        }
        await deps.install(here.state === 'untrusted' ? here.copy : null)
        const after = await deps.installed()
        if (after.state === 'untrusted') {
          putInUntrusted = after.copy.manifestDigest
          deps.warn('assistant App: in, and still not trusted; it is not put in again in this run', { attempt, version: after.copy.version, error: after.reason })
        }
        deps.info('assistant App: in', { attempt })
        await deps.afterInstall()
        return 'installed'
      } catch (error) {
        const wait = backoff[Math.min(attempt, backoff.length - 1)]!
        deps.warn('assistant App: did not go in; trying again', { attempt, retryInMs: wait, error: messageOf(error) })
        if (attempt === backoff.length - 1) deps.stuck?.(messageOf(error))
        await deps.sleep(wait)
      }
    }
  }

  return {
    ensure(reason) {
      if (reason === 'setup') setup = true
      running ??= run().finally(() => { running = null })
      return running
    },
    setupStarted: () => setup,
  }
}
