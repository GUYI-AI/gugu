// #1931 The personal assistant's product rules for setting it up (the first task, the child harness, the profile memory's
// wording), and the first-run introduction's words about it. On the desktop the main process answers with the rules it
// resolves now — the trusted assistant App's, the last good copy of them, or the built-in copy. The phone hosts no Apps'
// rules: the built-in copy.
import { BUILT_IN_ASSISTANT_RULES } from '@gugu/core/shared/assistantProductRules/builtIn'
import type { AssistantProductRules } from '@gugu/core/shared/assistantRulesFormat'
import { desktopIpc } from '../platform/desktopIpc'
import { ASSISTANT_HOME_CHANNELS } from './assistantHomeIpc'

export async function assistantSetupRules(): Promise<AssistantProductRules> {
  const ipc = desktopIpc()
  return ipc ? (await ipc.invoke(ASSISTANT_HOME_CHANNELS.rules)) as AssistantProductRules : BUILT_IN_ASSISTANT_RULES
}

/** The introduction's words by locale, or null when the rules in hand carry none. Reading them does not start a setup. */
export async function assistantIntroCopy(): Promise<AssistantProductRules['intro'] | null> {
  const ipc = desktopIpc()
  return ipc ? (await ipc.invoke(ASSISTANT_HOME_CHANNELS.intro)) as AssistantProductRules['intro'] | null : BUILT_IN_ASSISTANT_RULES.intro ?? null
}
