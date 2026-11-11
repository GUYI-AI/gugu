// #1931 The product's assistant App (assistant-rules-trust.ts) is on every machine whose assistant needs it, without the
// person doing anything: a profile created before the App joined the first-run set never runs that set again, so this
// puts it in at start — in the background, silently (the log only), retried with backoff until it is in. Never a toast,
// a question or a button.
//
// Whether it is needed here is one fact, not a record of intent: the assistant lives on this machine (its home is here,
// or this is a cloud machine hosting it), or its setup started in this run. An App the person uninstalled stays out while
// their assistant does not live here; while it does, the assistant needs the App, so it goes back in.
// An App installed here in any other way (a folder, a fork, switched off) is the person's: it is left as it is.

export interface AssistantAppEnsureDeps {
  /** Whether an App with the assistant App's id is installed here at all, whatever its origin. */
  installed(): boolean
  /** Whether this machine needs it now (see above). */
  needed(): boolean | Promise<boolean>
  /** Puts it in from the market as gugu's own (the market install with gugu's consent); throws what failed. */
  install(): Promise<void>
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

export type AssistantAppEnsureOutcome = 'present' | 'not-needed' | 'installed'

export interface AssistantAppEnsurer {
  /** One go, joined by any call while it runs. `setup`: the assistant's setup started, so it is needed from now on. */
  ensure(reason: 'start' | 'setup'): Promise<AssistantAppEnsureOutcome>
  /** Whether a setup asked for it in this run. */
  setupStarted(): boolean
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function assistantAppEnsurer(deps: AssistantAppEnsureDeps, backoff: readonly number[] = ASSISTANT_APP_ENSURE_BACKOFF_MS): AssistantAppEnsurer {
  let running: Promise<AssistantAppEnsureOutcome> | null = null
  let setup = false

  async function run(): Promise<AssistantAppEnsureOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        if (deps.installed()) return 'present'
        if (!setup && !(await deps.needed())) return 'not-needed'
        await deps.install()
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
