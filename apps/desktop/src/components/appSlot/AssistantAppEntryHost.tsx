import { useEffect, useState, useSyncExternalStore } from 'react'
import { observer } from 'mobx-react-lite'
import { refreshLocalAssistantHome } from '../../lib/assistantSetup'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { ASSISTANT_APP_ID, installAssistantAppEntryBridge, publishAssistantAppWord, useAssistantEntryTarget } from '../../lib/assistantEntry'
import { rendererLogger } from '../../lib/log'
import { useAuth } from '../../store/auth'
import { events, rpc } from '@/session/renderer/lib/ipc'
import { appState } from '@/session/renderer/lib/stores/app-state'
import { carryBuiltInPanelOnce } from '@/session/renderer/features/apps/app-conversation-panel'
import { homeTarget } from '@/session/renderer/features/assistant/assistant-home-sessions'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'

installAssistantAppEntryBridge()

const log = rendererLogger('assistant/app-entry')
const noop = () => () => undefined
/** A sync main could not verify (the database did not answer): asked again after these waits, then left to the next change. */
const ENTRY_SYNC_RETRY_MS: readonly number[] = [5_000, 30_000, 120_000]

/**
 * Entry switch, the shell's half (lib/assistantEntry.ts holds the one decision). Whenever the window's assistant changes —
 * the account, found / none, its private chat — or the assistant App does (installed, updated, switched, its grant or
 * choice, main's ensure step), main is asked to bring the trusted App's binding to that chat (`syncAssistantAppEntry`,
 * electron/.../assistant-app-entry.ts) and answers whether that App is the trusted one and whether it is being put in; that
 * answer is published for the entries. Background only: a failure is logged and tried again, never shown — the built-in page
 * stays the entry meanwhile.
 *
 * Also what the built-in page did by being opened, now that the App's page is opened instead: its panel state carried over
 * once (G6), and the assistant's home on this computer refreshed to this version each time the App's page comes up.
 */
export const AssistantAppEntryHost = observer(function AssistantAppEntryHost() {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const shell = readAssistantShellBridge()
  const snapshot = useSyncExternalStore(shell?.subscribe ?? noop, () => shell?.getSnapshot() ?? null)
  const mine = snapshot && ownerId && snapshot.ownerId === ownerId ? snapshot : null
  // The chat the window shows as the assistant's; null while it shows none (main decides whether that means "closed").
  const chatId = mine?.assistantState === 'found' ? mine.chatId : null
  const known = !!mine && (mine.assistantState === 'found' || mine.assistantState === 'none')
  const manifest = installedExtensionsStore.manifestFor(ASSISTANT_APP_ID)
  const installed = manifest ? JSON.stringify([manifest.version, installedExtensionsStore.origins[ASSISTANT_APP_ID] ?? null, installedExtensionsStore.isEnabled(ASSISTANT_APP_ID)]) : ''
  const [changes, setChanges] = useState(0)
  useEffect(() => events.on(extensionsInventoryChangedChannel, (note) => {
    if (!note?.extensionId || note.extensionId === ASSISTANT_APP_ID) setChanges((n) => n + 1)
  }), [])

  // Another account's answer is never used.
  useEffect(() => { publishAssistantAppWord(null) }, [ownerId])
  useEffect(() => {
    if (!ownerId || !known) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = (attempt: number) => {
      // Started inside the promise: a window without its host bridge refuses here, never in the effect.
      void Promise.resolve().then(() => rpc.extensions.syncAssistantAppEntry({ ownerId, chatId })).then((result) => {
        if (disposed) return
        if (!result.success) throw new Error(result.error)
        if (result.data.ownerId !== ownerId) return
        publishAssistantAppWord({ ownerId, trusted: result.data.trusted, ensuring: result.data.ensuring })
        if (result.data.outcome === 'unverified' && attempt < ENTRY_SYNC_RETRY_MS.length) {
          timer = setTimeout(() => ask(attempt + 1), ENTRY_SYNC_RETRY_MS[attempt])
        }
      }).catch((error: unknown) => {
        if (!disposed) log.warn({ error }, 'Could not bring the assistant App to the assistant\'s chat')
      })
    }
    ask(0)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [ownerId, known, chatId, installed, changes])

  const target = useAssistantEntryTarget()
  // The built-in page's panel, carried over the first time the App is where the entry goes.
  const carryTo = target.kind === 'app' ? target.extensionId : null
  useEffect(() => {
    if (carryTo && carryBuiltInPanelOnce(carryTo)) log.info({}, 'carried the built-in assistant panel state over to the assistant App')
  }, [carryTo])

  // The App's page is up: the assistant's home on this computer refreshed to this version, as opening the built-in page did.
  const onAppPage = target.kind === 'app' && appState.navigation.currentViewId === 'app' && appState.navigation.viewParamsStore.app?.appId === ASSISTANT_APP_ID
  const home = mine?.assistant ? mine.home : null
  const localHome = home?.kind === 'computer' && homeTarget(home) === null
  const agentType = mine?.assistant?.agent_type
  const engine = agentType === 'codex' ? 'codex' : agentType === 'claude-code' ? 'claude' : null
  useEffect(() => {
    if (onAppPage && localHome && engine) void refreshLocalAssistantHome(engine).catch((error: unknown) => log.warn({ error }, 'Local assistant instructions refresh failed'))
  }, [onAppPage, localHome, engine])
  return null
})
