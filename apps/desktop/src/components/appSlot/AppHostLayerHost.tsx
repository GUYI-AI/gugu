import { useEffect, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { AssistantSettingsPage } from '../assistant/AssistantSettingsPage'
import { AssistantWorkTaskWindow } from '../assistant/AssistantWorkTaskWindow'
import { readAppConversationSurfaceBridge, type AppConversationHeaders } from '../../lib/appConversationSurfaceBridge'
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
const NO_HEADERS: AppConversationHeaders = Object.freeze({})
const noop = () => () => undefined

/**
 * #1925 (API 46) The host pages over Apps' panels, one per App (app-host-layer.ts): the shell's half. Each is the built-in
 * page itself — a task's conversation (AssistantWorkTaskWindow), the assistant's settings (AssistantSettingsPage) — drawn in
 * the cell the App's panel leaves for it, for the account it was opened for and no other.
 *
 * Taken away at once when that changes: another account; leaving the session page; the App switched off, removed, or main
 * naming its grant or choice as changed; and what opened it gone — a task's App no longer reading work, the settings' App no
 * longer drawn with the host's row above its conversation. Each open and close is told to main (`reportHostLayer`), which
 * tells the App only that a host page is there (and with `chat:work` which row). Nothing of a page reaches the App.
 */
export const AppHostLayerHost = observer(function AppHostLayerHost({ visible }: {
  /** 会话页那一屏此刻摆在眼前(MainLayout 的 tab 在「任务」):离开就收起,与内置任务窗同一条判据。 */
  visible: boolean
}) {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const reading = installedExtensionsStore.manifests.filter((manifest) => readsWork(manifest) && installedExtensionsStore.isEnabled(manifest.id)).map((manifest) => manifest.id)
  const readingKey = reading.join('\n')
  const surfaces = readAppConversationSurfaceBridge()
  const headers = useSyncExternalStore(surfaces?.subscribe ?? noop, () => surfaces?.getHeaders() ?? NO_HEADERS)
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
    const opened = (extensionId: string, layer: AppHostLayer) => layer.kind === 'work'
      ? still.has(extensionId)
      : headers[extensionId]?.kind === 'assistant' && headers[extensionId].ownerId === layer.ownerId
    retainAppHostLayers((extensionId, layer) => visible && layer.ownerId === ownerId && opened(extensionId, layer))
  }, [visible, ownerId, readingKey, headers, layers])
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
            <AssistantWorkTaskWindow ownerId={layer.ownerId} request={layer.request} onClose={close} />,
            element,
            `${extensionId}#work#${layer.request.workId}#${layer.request.task.sessionId}`,
          )]
        }
        // The panel's settings page as the built-in panel draws it (AssistantShellHost's `settings` cell).
        return [createPortal(<AssistantSettingsPage panelNavigation />, element, `${extensionId}#${layer.kind}`)]
      })}
    </>
  )
}
