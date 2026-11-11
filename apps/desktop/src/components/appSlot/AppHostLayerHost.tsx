import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { AssistantSettingsPage, AssistantSetupPage } from '../assistant/AssistantSettingsPage'
import { ConnectorsSection } from '../settings/ConnectorsSection'
import { AssistantWorkTaskWindow } from '../assistant/AssistantWorkTaskWindow'
import { appHostLayerSlotKey, installAppHostLayerBridge, readAppHostLayerBridge, retainAppHostLayers, setAppHostLayerAccount, type AppHostLayer, type AppHostLayers } from '../../lib/appHostLayerBridge'
import { installShellSlots, readShellSlots } from '../../lib/shellSlots'
import { useAuth } from '../../store/auth'
import { events } from '@/session/renderer/lib/ipc'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'
import { reportHostLayers } from './appHostLayer'
import { readsWork } from './appWorkLedger'

installShellSlots()
installAppHostLayerBridge()

const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()
const NONE: AppHostLayers = Object.freeze({})
const noop = () => () => undefined

/**
 * #1925 (API 46) The host pages over Apps' panels, one per App (app-host-layer.ts): the shell's half. Each is the built-in
 * page itself — a task's conversation (AssistantWorkTaskWindow), the assistant's setup guide (AssistantSetupPage), its
 * settings (AssistantSettingsPage), the apps connected to it (ConnectorsSection) — drawn in the cell the App's panel leaves
 * for it, for the account it was opened for and no other.
 *
 * Taken away at once when that changes: another account; the App switched off or removed, or main naming its grant or choice
 * as changed; for a task, also leaving the session page or the App no longer reading work (the session page closes a panel
 * page whose App page went, or whose assistant this window no longer shows). Each open and close is told to main
 * (`reportHostLayer`), which tells the App only that a host page is there (and with `chat:work` which row). Nothing of a
 * page reaches the App.
 */
export const AppHostLayerHost = observer(function AppHostLayerHost({ visible }: {
  /** 会话页那一屏此刻摆在眼前(MainLayout 的 tab 在「任务」):离开就收起,与内置任务窗同一条判据。 */
  visible: boolean
}) {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const reading = installedExtensionsStore.manifests.filter((manifest) => readsWork(manifest) && installedExtensionsStore.isEnabled(manifest.id)).map((manifest) => manifest.id)
  const readingKey = reading.join('\n')
  const onKey = installedExtensionsStore.manifests.filter((manifest) => installedExtensionsStore.isEnabled(manifest.id)).map((manifest) => manifest.id).join('\n')
  const bridge = readAppHostLayerBridge()
  const layers = useSyncExternalStore(bridge?.subscribe ?? noop, () => bridge?.getSnapshot() ?? NONE)

  // Only this account's pages open (before anything below is drawn for it).
  setAppHostLayerAccount(ownerId)
  // Main named this App's grant, choice, switch or installation as changed (no App named: all of them): its page goes.
  useEffect(() => events.on(extensionsInventoryChangedChannel, (note) => {
    const changed = note?.extensionId
    retainAppHostLayers((extensionId) => changed !== undefined && extensionId !== changed)
  }), [])
  useEffect(() => {
    const still = new Set(readingKey ? readingKey.split('\n') : [])
    const on = new Set(onKey ? onKey.split('\n') : [])
    // A task: as the built-in task window, only while the session page is on screen and the App reads work. A page of the
    // assistant's panel: while the App is installed and on (its page gone, or the assistant: the session page closes it).
    const keep = (extensionId: string, layer: AppHostLayer) => layer.kind === 'work' ? visible && still.has(extensionId) : on.has(extensionId)
    retainAppHostLayers((extensionId, layer) => layer.ownerId === ownerId && keep(extensionId, layer))
  }, [visible, ownerId, readingKey, onKey, layers])
  useEffect(() => reportHostLayers(layers), [layers])

  return <AppHostLayerPortals ownerId={ownerId} layers={layers} />
})

/** Each App's host page, drawn into the cell its panel leaves — for the account it was opened for. */
function AppHostLayerPortals({ ownerId, layers }: { ownerId: string | null; layers: AppHostLayers }) {
  const slots = readShellSlots()
  const entries = useSyncExternalStore(slots?.subscribeSlots ?? noop, () => slots?.getSlots() ?? EMPTY)
  return (
    <>
      {Object.entries(layers).flatMap(([extensionId, layer]) => {
        const element = entries.get(appHostLayerSlotKey(extensionId))
        if (!element || !ownerId || layer.ownerId !== ownerId) return []
        if (layer.kind === 'work') {
          const close = () => readAppHostLayerBridge()?.close(extensionId, 'work')
          return [createPortal(
            <AssistantWorkTaskWindow ownerId={layer.ownerId} request={layer.request} onClose={close} appPanel />,
            element,
            `${extensionId}#work#${layer.request.workId}#${layer.request.task.sessionId}`,
          )]
        }
        // The assistant's own pages this tree draws. The panel's other pages need nothing of this tree: the session page draws
        // them (app-host-layer.tsx).
        const page = layer.kind === 'assistant-setup' ? <AssistantSetupPage />
          : layer.kind === 'assistant-settings' ? <AssistantSettingsPage panelNavigation />
          : layer.kind === 'assistant-connected-apps' ? <ConnectorsSection panelNavigation />
          : null
        return page ? [createPortal(page, element, `${extensionId}#${layer.kind}`)] : []
      })}
    </>
  )
}
