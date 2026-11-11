// #1931 Whether the assistant on this computer waits for its product rules (the assistant App is being put in): its entry
// shows it preparing meanwhile, and once getting them is truly stuck, one failure notice says so — through the app's one
// notice outlet, never a strip above the composer. Main decides both (electron/assistant-rules-root.ts); a phone or a
// web page hosts no assistant, so it never waits.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { desktopIpc } from '../platform/desktopIpc'
import { ASSISTANT_HOME_CHANNELS, type AssistantRulesState } from './assistantHomeIpc'
import { notify } from './notices'
import { rendererLogger } from './log'
import '../i18n/registerMainCatalog'

const log = rendererLogger('assistant-rules')
const NOT_WAITING: AssistantRulesState = { pending: false, stuck: false }

export function useAssistantRulesState(): AssistantRulesState {
  const [state, setState] = useState<AssistantRulesState>(NOT_WAITING)
  useEffect(() => {
    const ipc = desktopIpc()
    if (!ipc) return
    let live = true
    ipc.invoke(ASSISTANT_HOME_CHANNELS.rulesState).then(
      (value) => { if (live) setState(value as AssistantRulesState) },
      (error: unknown) => log.warn({ error: String(error) }, 'assistant rules state not read; the entry shows as it is'),
    )
    const off = ipc.eventOn(ASSISTANT_HOME_CHANNELS.rulesStateChanged, (value) => setState(value as AssistantRulesState))
    return () => { live = false; off() }
  }, [])
  return state
}

/** The one notice for a truly stuck wait: shown when it becomes stuck, in place (by key) if it is shown already. */
export function useAssistantRulesStuckNotice(stuck: boolean): void {
  const { t } = useTranslation('main')
  useEffect(() => {
    if (!stuck) return
    notify({ key: 'assistant-rules-stuck', tier: 'error', title: t('assistantRules.stuckTitle'), description: t('assistantRules.stuckBody') })
  }, [stuck, t])
}
