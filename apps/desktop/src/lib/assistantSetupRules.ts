// #1931 The personal assistant's product rules for setting it up (the first task, the child harness, the profile memory's
// wording). On the desktop the main process answers with the rules it
// resolves — the trusted assistant App's, or the last good copy of them; with neither yet, its setup answer waits for the
// App to go in. The phone (and a web page) reads them from the market's assistant App (phoneAssistantRules.ts).
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { desktopIpc } from '../platform/desktopIpc'
import { ASSISTANT_HOME_CHANNELS } from './assistantHomeIpc'

/** Thrown where the assistant cannot be set up because its rules cannot be had here now (the phone offline, say). */
export class AssistantRulesUnavailableError extends Error {
  constructor() {
    super('the assistant\'s product rules are not available here')
    this.name = 'AssistantRulesUnavailableError'
  }
}

const phoneRules = async () => (await import('../components/appSlot/phoneAssistantRules')).phoneAssistantRules()

export async function assistantSetupRules(): Promise<AssistantProductRules> {
  const ipc = desktopIpc()
  if (ipc) return (await ipc.invoke(ASSISTANT_HOME_CHANNELS.rules)) as AssistantProductRules
  const rules = await phoneRules()
  if (!rules) throw new AssistantRulesUnavailableError()
  return rules
}
