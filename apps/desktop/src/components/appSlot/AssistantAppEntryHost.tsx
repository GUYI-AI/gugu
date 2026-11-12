import { useEffect, useState, useSyncExternalStore } from 'react'
import { observer } from 'mobx-react-lite'
import { refreshLocalAssistantHome } from '../../lib/assistantSetup'
import { readAssistantShellBridge } from '../../lib/assistantShellBridge'
import { ASSISTANT_APP_ID, installAssistantAppEntryBridge, publishAssistantAppWord, useAssistantEntryTarget } from '../../lib/assistantEntry'
import { rendererLogger } from '../../lib/log'
import { useAuth } from '../../store/auth'
import { events, rpc } from '@/session/renderer/lib/ipc'
import { appState } from '@/session/renderer/lib/stores/app-state'
import { assistantHandedOver, carryBuiltInPanelOnce, keepBuiltInAssistantLastTab, keptBuiltInAssistantLastTab, markAssistantHandedOver } from '@/session/renderer/features/apps/app-conversation-panel'
import { homeTarget } from '@/session/renderer/features/assistant/assistant-home-sessions'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'

installAssistantAppEntryBridge()

const log = rendererLogger('assistant/app-entry')
const noop = () => () => undefined
/** A sync main could not verify (the database did not answer): asked again after these waits, then left to the next change. */
const ENTRY_SYNC_RETRY_MS: readonly number[] = [5_000, 30_000, 120_000]
const handingOver = new Set<string>()

/** What the navigation snapshot held for the built-in assistant page's view, a view this build no longer has (its last tab). */
const retiredAssistantParams = (): { tab?: unknown } | undefined =>
  appState.navigation.retiredViewParams.assistant as { tab?: unknown } | undefined

/**
 * Entry switch, the shell's half (lib/assistantEntry.ts holds the one decision). Whenever the window's assistant changes —
 * the account, found / none, its private chat — or the assistant App does (installed, updated, switched, its grant or
 * choice), main is asked to bring the trusted App's binding to that chat (`syncAssistantAppEntry`,
 * electron/.../assistant-app-entry.ts) and answers whether that App is the trusted one; that answer is
 * published for the entries. Background only: a failure is logged and tried again, never shown — the built-in page
 * stays the entry meanwhile. The App is bound only once the assistant's setup is ready for that chat (main answers `pending` before).
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
  // Where the assistant's setup is (`setup`) and whether it is still being made (`preparing`): its private chat is known before
  // the assistant is ready, and the binding waits for ready (main: `pending`), so the end of the setup is asked again.
  const setupStep = mine?.setup ?? null
  const preparing = mine?.preparing === true
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
        publishAssistantAppWord({ ownerId, trusted: result.data.trusted })
        // `pending`: the assistant's setup has not finished, so nothing was bound yet (the App would be refused over it): asked
        // again as `unverified` is, and whenever the setup moves on (below).
        if ((result.data.outcome === 'unverified' || result.data.outcome === 'pending') && attempt < ENTRY_SYNC_RETRY_MS.length) {
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
  }, [ownerId, known, chatId, installed, changes, setupStep, preparing])

  const target = useAssistantEntryTarget()
  // The built-in page's panel, carried over the first time the App is where the entry goes.
  // Carried at the first bind: the App drawn beside the account's own assistant chat.
  const carryTo = target.kind === 'app' && target.chatId ? target.extensionId : null
  useEffect(() => {
    if (carryTo && carryBuiltInPanelOnce(carryTo)) log.info({}, 'carried the built-in assistant panel state over to the assistant App')
  }, [carryTo])
  // G6: the tab the person last had open on the built-in page, handed to the App once for this account here; main holds it
  // until the App's page reads its surface (the first read or event). Not held (not the trusted App, main not reached): asked
  // again the next time the App becomes where the entry goes; nothing is said.
  useEffect(() => { keepBuiltInAssistantLastTab(retiredAssistantParams()) }, [])
  useEffect(() => {
    if (!carryTo || !ownerId || assistantHandedOver(ownerId)) return
    const tab = keptBuiltInAssistantLastTab()
    if (!tab) {
      markAssistantHandedOver(ownerId)
      return
    }
    // One ask at a time per account (the entry may flip while the answer is on its way); its answer stands either way.
    if (handingOver.has(ownerId)) return
    handingOver.add(ownerId)
    Promise.resolve().then(() => rpc.extensions.handOverAssistantPage({ ownerId, tab })).then((result) => {
      if (!result.success) throw new Error(result.error)
      if (result.data.held) markAssistantHandedOver(ownerId)
    }).catch((error: unknown) => log.warn({ error: String(error) }, 'the built-in assistant page\'s last tab was not handed to the App now'))
      .finally(() => handingOver.delete(ownerId))
  }, [carryTo, ownerId])

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
