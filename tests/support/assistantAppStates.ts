// The assistant App's states, set up through the real inputs of the one entry decision (lib/assistantEntry.ts): what the
// installed-Apps store holds, and what main said about the installed copy. Every route into the assistant is tested against
// each state it must treat the same way: the App not usable here.
import { ASSISTANT_APP_ID, installAssistantAppEntryBridge, publishAssistantAppWord } from '../../apps/desktop/src/lib/assistantEntry'
import { installedExtensionsStore } from '../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { EXTENSION_API_VERSION } from '../../apps/desktop/src/session/shared/extensions/manifest'

export type AssistantAppState = 'usable' | 'switched off' | 'being put in' | 'failing to go in'

/** The three ways the App is not usable here; they are told apart by what the person and main said, not by any route. */
export const UNAVAILABLE_APP_STATES = ['switched off', 'being put in', 'failing to go in'] as const

const manifest = {
  id: ASSISTANT_APP_ID, name: 'A', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  permissions: { capabilities: ['chat:unread'], bindings: [{ name: 'main', kind: 'conversation', actions: ['unread', 'surface', 'work'] }] },
  contributes: { tabs: [{ name: 'today', title: 'A' }] },
}
const apply = (installed: boolean, disabled: boolean) => installedExtensionsStore.applyList({
  extensions: installed ? [manifest] : [], invalid: [], icons: {}, disabled: installed && disabled ? [ASSISTANT_APP_ID] : [], disclosure: {}, dock: [],
} as never)

/**
 * - usable: installed, on, main trusts it.
 * - switched off: installed, trusted, the person turned it off.
 * - being put in: not installed yet, the ensure step is on its way (main has not answered about a copy yet).
 * - failing to go in: still not installed, main has answered "none here" and the ensure step keeps failing (the stuck notice).
 */
export function setAssistantAppState(state: AssistantAppState, ownerId: string): void {
  installAssistantAppEntryBridge()
  if (state === 'usable') { apply(true, false); publishAssistantAppWord({ ownerId, trusted: true }) }
  else if (state === 'switched off') { apply(true, true); publishAssistantAppWord({ ownerId, trusted: true }) }
  else if (state === 'being put in') { apply(false, false); publishAssistantAppWord(null) }
  else { apply(false, false); publishAssistantAppWord({ ownerId, trusted: false }) }
}

export function clearAssistantAppState(): void {
  apply(false, false)
  publishAssistantAppWord(null)
}
