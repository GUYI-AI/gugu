import { useEffect, useSyncExternalStore } from 'react'
import { assistantAppEnsurer, type AssistantAppEnsureOutcome, type AssistantAppEnsurer } from '../../../electron/assistant-app-ensure'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { ASSISTANT_APP_ID } from '../../session/shared/extensions/assistant-entry'

/**
 * #1931 The assistant App on every phone whose account has an assistant, as on a computer (electron/assistant-app-ensure.ts,
 * the same ensurer, the same backoff): the layer's 动态 / 任务 / 记忆 / 资料 are the App's page, so the phone puts it in by
 * itself — from the market as gugu's own (`installFromMarket`, consent `gugu`: only an App whose code is in gugu's own
 * repository, its signed release verified before the package is fetched, phoneMarket.ts), in the background, retried, never a
 * prompt, a toast or a button. Needed = the account signed in on this phone has its assistant. An App with its id installed
 * in any other way (from a chat card, switched off) is the person's: left as it is. Bound by the shared rule: the phone binds
 * the trusted App to the account's private chat with its own assistant on every call (phoneAppBindings.ts `bound`).
 */

const log = rendererLogger('assistant/app-ensure')

export interface PhoneAssistantAppEnsureDeps {
  /** Whether an App with the assistant App's id is installed on this phone at all, whatever its origin. */
  installed(): boolean
  /** Puts it in from the market as gugu's own; throws what failed. */
  install(): Promise<void>
  /** The phone's App store read (before `installed` is believed). */
  ready(): Promise<unknown>
  sleep(ms: number): Promise<void>
}

export function createPhoneAssistantAppEnsure(deps: PhoneAssistantAppEnsureDeps, backoff?: readonly number[]) {
  let hasAssistant = false
  let stuck = false
  const listeners = new Set<() => void>()
  const setStuck = (next: boolean) => {
    if (stuck === next) return
    stuck = next
    for (const listener of listeners) listener()
  }
  const ensurer: AssistantAppEnsurer = assistantAppEnsurer({
    installed: deps.installed,
    needed: () => hasAssistant,
    install: deps.install,
    afterInstall: deps.ready,
    sleep: deps.sleep,
    warn: (message, detail) => log.warn(detail, message),
    info: (message, detail) => log.info(detail, message),
    stuck: (error) => {
      log.error({ error }, 'assistant App: still not in after the whole backoff window')
      setStuck(true)
    },
  }, backoff)
  return {
    /** The account's assistant was found (or is gone): when it is there and the App is not, the App goes in. */
    async ensure(found: boolean): Promise<AssistantAppEnsureOutcome> {
      hasAssistant = found
      if (!found) return 'not-needed'
      await deps.ready()
      const outcome = await ensurer.ensure('assistant')
      if (outcome === 'installed') setStuck(false)
      return outcome
    },
    /** Every try of the backoff window failed (it goes on trying): the one place a real failure may be said, in place. */
    stuck: () => stuck,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

let shared: ReturnType<typeof createPhoneAssistantAppEnsure> | null = null
// The phone's App store, loaded with the first ensure (`ready` runs before `installed` is asked).
let apps: typeof import('./phoneApps').phoneApps | null = null
const loadApps = async () => (apps ??= (await import('./phoneApps')).phoneApps)
function phoneEnsure() {
  shared ??= createPhoneAssistantAppEnsure({
    installed: () => apps?.installRecord(ASSISTANT_APP_ID) != null,
    install: async () => {
      const done = await (await loadApps()).installFromMarket({ ref: { extensionId: ASSISTANT_APP_ID }, consent: { kind: 'gugu' } })
      if (!done.success) throw new Error(done.error)
      if (!done.data.installed) throw new Error(`${ASSISTANT_APP_ID} did not go in (${done.data.outcome})`)
    },
    ready: async () => (await loadApps()).ready(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
  })
  return shared
}

/**
 * The phone shell, once it knows the account's assistant: the App put in where it is missing — asked again whenever the
 * phone's App store changes (`inventory`), so an App the person removed goes back in while they have an assistant. Only in
 * the phone app: a computer has its own (main).
 */
export function usePhoneAssistantAppEnsure(assistantId: string | null, inventory: string): void {
  const phone = platform.kind === 'capacitor'
  useEffect(() => {
    if (!phone) return
    if (!assistantId) {
      void shared?.ensure(false)
      return
    }
    void phoneEnsure().ensure(true).catch((error: unknown) => log.warn({ error: error instanceof Error ? error.message : String(error) }, 'assistant App: not ensured'))
  }, [phone, assistantId, inventory])
}

const noStuck = () => () => undefined
/** Whether putting the App in is truly stuck (said once, in place of the sections, while it keeps trying). */
export function usePhoneAssistantAppStuck(): boolean {
  const phone = platform.kind === 'capacitor'
  return useSyncExternalStore(phone ? (listener) => phoneEnsure().subscribe(listener) : noStuck, () => (phone ? phoneEnsure().stuck() : false), () => false)
}
