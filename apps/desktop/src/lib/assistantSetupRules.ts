// #1931 The personal assistant's product rules for setting it up (the first task, the child harness, the profile memory's
// wording). On the desktop the main process answers with the rules it resolves now — the trusted assistant App's, the last
// good copy of them, or the built-in copy. The phone hosts no Apps' rules: the built-in copy.
import { BUILT_IN_ASSISTANT_RULES } from '@gugu/core/shared/assistantProductRules/builtIn'
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { desktopIpc } from '../platform/desktopIpc'
import { ASSISTANT_HOME_CHANNELS } from './assistantHomeIpc'

export async function assistantSetupRules(): Promise<AssistantProductRules> {
  const ipc = desktopIpc()
  return ipc ? (await ipc.invoke(ASSISTANT_HOME_CHANNELS.rules)) as AssistantProductRules : BUILT_IN_ASSISTANT_RULES
}
