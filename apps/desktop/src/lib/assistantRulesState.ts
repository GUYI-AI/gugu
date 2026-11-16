// #1931 Whether the assistant on this computer waits for its product rules (the assistant App is being put in): its entry
// shows it preparing meanwhile, and once getting them is truly stuck, one failure notice says so — through the app's one
// notice outlet, never a strip above the composer. Main decides both (electron/assistant-rules-root.ts); a phone or a
// web page hosts no assistant, so it never waits.
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { desktopIpc } from '../platform/desktopIpc'
import { ASSISTANT_HOME_CHANNELS, type AssistantRulesState } from './assistantHomeIpc'
import { notify } from './notices'
import { replica, useReplica, type Reading } from './replica'
import '../i18n/registerMainCatalog'

/**
 * Main's answer for the signed-in account (account scope: whether it waits depends on whether this account has an
 * assistant here, so an account switch never shows the last account's wait). With no desktop IPC (a phone, a web page)
 * nothing hosts an assistant here, so it truly does not wait: `{pending: false, stuck: false}` is the value, ❌ a placeholder. Main pushes every change with its value
 * (`rulesStateChanged`), so a read value stays current (`fresh: Infinity`). Not kept across restarts (a restored `pending`
 * would flash "preparing").
 */
export const assistantRulesState = replica({
  name: 'assistantRulesState',
  scope: 'account',
  read: async (): Promise<AssistantRulesState> => {
    const ipc = desktopIpc()
    if (!ipc) return { pending: false, stuck: false }
    return (await ipc.invoke(ASSISTANT_HOME_CHANNELS.rulesState)) as AssistantRulesState
  },
  fresh: Infinity,
  watch: {
    // Main publishes for the account signed in now: put it there (bound per feed, which follows the account).
    start: () => {
      const entry = assistantRulesState.at()
      return desktopIpc()?.eventOn(ASSISTANT_HOME_CHANNELS.rulesStateChanged, (value) => entry.set(value as AssistantRulesState)) ?? (() => undefined)
    },
  },
})


/** Unknown until main answers: the entry is not drawn as preparing meanwhile (❌ a literal "not waiting" either). */
export function useAssistantRulesState(): Reading<AssistantRulesState> {
  return useReplica(assistantRulesState, [])
}

/** The one notice for a truly stuck wait: shown when it becomes stuck, in place (by key) if it is shown already. */
export function useAssistantRulesStuckNotice(stuck: boolean): void {
  const { t } = useTranslation('main')
  useEffect(() => {
    if (!stuck) return
    notify({ key: 'assistant-rules-stuck', tier: 'error', title: t('assistantRules.stuckTitle'), description: t('assistantRules.stuckBody') })
  }, [stuck, t])
}
