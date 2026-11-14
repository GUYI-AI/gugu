import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { observer } from 'mobx-react-lite'
import '../../i18n/registerAssistantCatalog'
import { ChatAreaPanel } from '../ChatAreaPanel'
import type { AssistantChatHandlers } from '../assistant/AssistantChatSlot'
import { Plus } from '../../lib/icons'
import { rendererLogger } from '../../lib/log'
import { useReportChatOnScreen } from '../../lib/onScreenChat'
import { installShellSlots, readShellSlots } from '../../lib/shellSlots'
import { APP_CONVERSATION_SLOT_PREFIX, installAppConversationSurfaceBridge, noteAppConversationDrawn, publishAppConversationSurfaces } from '../../lib/appConversationSurfaceBridge'
import { readAssistantShellBridge, type AssistantShellAssistant } from '../../lib/assistantShellBridge'
import { useAuth } from '../../store/auth'
import { useAppComposerEntries } from './appComposerActions'
import { AppComposerRow } from './AppComposerRow'
import { useStoreValueBy } from '../../store/chatContext'
import { events, rpc } from '@/session/renderer/lib/ipc'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import type { ExtensionManifest } from '@/session/shared/extensions/manifest'
import { extensionsInventoryChangedChannel } from '@/session/shared/extensions/marketEvents'
import type { GrantedSurfaceBinding } from '@/session/shared/extensions/unread-binding'

installShellSlots()
installAppConversationSurfaceBridge()

const log = rendererLogger('app-conversation-surface')
const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()
// The built-in assistant's chat face (AssistantChatSlot), without its typing line. The 「+」 holds what the App declares for
// the person's own assistant chat (API 48, appComposerActions.tsx), run by the host. Over that chat (46's `header`, main's
// word) the composer says what the built-in's did, 「和<its name>聊天」, the name read as the host's row reads it, and the row
// above it has the built-in's 「自定义<name>」 hint and the App's capsule (AppComposerRow).
const noop = () => () => undefined

/** What one read answered for one account: each App's binding, and each App as installed when it was read. */
type Verified = { ownerId: string; bindings: Record<string, GrantedSurfaceBinding>; installed: Record<string, string> }
/** Apps main said changed (`extensionsInventoryChangedChannel`) since the last read, and how many such notes there were. */
type Changed = { apps: ReadonlySet<string>; serial: number }

/** One App as installed here: what its update, or a reinstall from another publisher, changes. Another App's never does. */
function installedAs(manifest: ExtensionManifest): string {
  return JSON.stringify([manifest, installedExtensionsStore.origins[manifest.id] ?? null, installedExtensionsStore.publishers[manifest.id] ?? null])
}

/**
 * #1925 An App's main page beside the conversation its binding is bound to: the shell's half. Which conversation may be
 * drawn is the host's — the signed-in account's own selection for that installed App, `chat:surface` granted, still a member
 * (main's `grantedSurfaceBindings`), with a stamp of that authority. Each App's column is kept or dropped by its own
 * authority alone: when another App is installed, updated, switched or removed, a column stays mounted with all it holds
 * (scroll, draft, voice input, a reply streaming in). It is dropped at once when its own authority changes — the account
 * switched; this App switched off, uninstalled or updated; main naming this App's grant, choice or switch as changed — and
 * drawn again only when a new read says so; a read whose stamp for it is new draws it anew. A conversation that left the
 * chat list is not drawn. Published to the session page (lib/appConversationSurfaceBridge.ts), which lays out the frame and
 * leaves the column's slot; the conversation itself is the ordinary native one (ChatAreaPanel), in this tree. Nothing of it
 * reaches the App.
 */
export const AppConversationSurfaceHost = observer(function AppConversationSurfaceHost({ visible, ...handlers }: {
  /** 会话页那一屏此刻摆在眼前(MainLayout 的 tab 在「任务」):与「助理」App 的聊天同一条判据。 */
  visible: boolean
} & AssistantChatHandlers) {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const inventory = installedExtensionsStore.manifests
  const placing = inventory.filter((manifest) => manifest.contributes.conversationSurface && installedExtensionsStore.isEnabled(manifest.id))
  const wanted = placing.length > 0
  const [verified, setVerified] = useState<Verified | null>(null)
  const [changed, setChanged] = useState<Changed>({ apps: new Set(), serial: 0 })
  useEffect(() => events.on(extensionsInventoryChangedChannel, (note) => {
    const extensionId = note?.extensionId
    setChanged((before) => ({ apps: extensionId ? new Set([...before.apps, extensionId]) : before.apps, serial: before.serial + 1 }))
  }), [])
  // Another account's read is never used again, not even on switching back.
  useEffect(() => { setVerified((before) => (before && before.ownerId !== ownerId ? null : before)) }, [ownerId])
  useEffect(() => {
    if (!ownerId || !wanted) return
    let disposed = false
    const asked = changed.serial
    const installed = Object.fromEntries(inventory.map((manifest) => [manifest.id, installedAs(manifest)]))
    void rpc.extensions.conversationSurfaceBindings({ ownerId }).then((result) => {
      if (disposed) return
      if (!result.success || result.data.ownerId !== ownerId) throw new Error('App conversation surface authority unavailable')
      setVerified({ ownerId, bindings: result.data.bindings, installed })
      setChanged((now) => (now.serial === asked && now.apps.size > 0 ? { apps: new Set(), serial: asked } : now))
    }).catch((error: unknown) => {
      // A read that failed takes nothing back that it could not check: what was verified stays, an App changed stays undrawn.
      if (!disposed) log.warn({ error }, 'Could not verify App conversation surfaces')
    })
    return () => { disposed = true }
  }, [ownerId, inventory, wanted, changed.serial])
  const current = verified && verified.ownerId === ownerId ? verified : null
  // An App switched off, uninstalled, or not as it was installed when read: not drawn, and forgotten — only a new read
  // brings it back, never this one.
  const lapsed = current ? Object.keys(current.bindings).filter((id) => !placing.some((manifest) => manifest.id === id && current.installed[id] === installedAs(manifest))) : []
  const lapsedKey = lapsed.join('\n')
  useEffect(() => {
    if (!lapsedKey) return
    const gone = new Set(lapsedKey.split('\n'))
    setVerified((before) => before && { ...before, bindings: Object.fromEntries(Object.entries(before.bindings).filter(([id]) => !gone.has(id))) })
  }, [lapsedKey])
  const candidates = placing.flatMap((manifest) => {
    const binding = current?.bindings[manifest.id]
    if (!binding || changed.apps.has(manifest.id) || lapsed.includes(manifest.id)) return []
    // 46: the host's row above it, only as main verified it for this read (declared, and the account's own assistant chat).
    const header = binding.header === 'assistant' && manifest.contributes.conversationSurface?.header === 'assistant' ? 'assistant' : null
    return binding.ownerId === ownerId && binding.name === manifest.contributes.conversationSurface?.binding ? [[manifest.id, binding.chatId, binding.authority, header] as const] : []
  })
  // Still in it: the chat list is the account's own membership, as the rail's unread source reads it.
  const wantedChats = candidates.map(([, chatId]) => chatId)
  const present = useStoreValueBy((store) => store.chats.filter((chat) => wantedChats.includes(chat.id)).map((chat) => chat.id),
    (store) => store.chats.filter((chat) => wantedChats.includes(chat.id)).map((chat) => chat.id))
  const signature = JSON.stringify(candidates.filter(([, chatId]) => present.includes(chatId)))
  // The signature is the dependency: a new object only when what may be drawn, or its authority, changed.
  const drawable = useMemo(() => new Map((JSON.parse(signature) as [string, string, string, 'assistant' | null][]).map(([id, chatId, authority, header]) => [id, { chatId, authority, header }])), [signature])
  useEffect(() => {
    publishAppConversationSurfaces(
      Object.fromEntries([...drawable].map(([id, { chatId }]) => [id, chatId])),
      Object.fromEntries([...drawable].flatMap(([id, { header }]) => (header && ownerId ? [[id, { kind: header, ownerId }]] : []))),
    )
  }, [drawable, ownerId])
  useEffect(() => () => publishAppConversationSurfaces({}), [])

  const slots = readShellSlots()
  const entries = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => undefined),
    () => slots?.getSlots() ?? EMPTY,
  )
  return (
    <>
      {[...entries].flatMap(([key, element]) => {
        if (!key.startsWith(APP_CONVERSATION_SLOT_PREFIX)) return []
        const surface = drawable.get(key.slice(APP_CONVERSATION_SLOT_PREFIX.length))
        // Keyed by its authority too: the same conversation under a new grant, choice or installation is drawn anew.
        return surface && ownerId ? [createPortal(<AppConversationColumn chatId={surface.chatId} viewportKey={key} visible={visible} ownerId={ownerId}
          extensionId={key.slice(APP_CONVERSATION_SLOT_PREFIX.length)} authority={surface.authority} ownAssistant={surface.header === 'assistant'} {...handlers} />, element, `${key}#${surface.authority}`)] : []
      })}
    </>
  )
})

/**
 * The assistant the shell has for this account, when `chatId` is its private chat (as the host's row above it reads it,
 * app-conversation-frame.tsx): else null — another account's, still being read, or another chat.
 */
function useOwnAssistant(ownerId: string, chatId: string, verified: boolean): AssistantShellAssistant | null {
  const bridge = readAssistantShellBridge()
  const snapshot = useSyncExternalStore(bridge?.subscribe ?? noop, () => bridge?.getSnapshot() ?? null)
  return verified && snapshot?.ownerId === ownerId && snapshot.chatId === chatId ? snapshot.assistant : null
}

/**
 * The native conversation in the column, as the built-in assistant's (AssistantChatSlot): seen only while the slot is up and
 * the session page is on screen — the one rule read confirmation follows there. Opening the App does not confirm anything.
 * `ownAssistant`: main verified it is the account's own assistant chat and the App declared the host's row over it (46).
 */
const AppConversationColumn = memo(function AppConversationColumn({ chatId, viewportKey, visible, ownerId, extensionId, authority, ownAssistant, ...handlers }: {
  chatId: string; viewportKey: string; visible: boolean; ownerId: string; extensionId: string; authority: string; ownAssistant: boolean
} & AssistantChatHandlers) {
  const { t } = useTranslation('assistant')
  useReportChatOnScreen(visible ? chatId : null)
  // A draft for this chat (`gugu.dispatch`) lands in this composer while it is drawn: the chat need not come up (MainLayout).
  useEffect(() => noteAppConversationDrawn(chatId), [chatId])
  const { menu: attachMenu, chip } = useAppComposerEntries({ ownerId, extensionId, authority, chatId })
  const own = useOwnAssistant(ownerId, chatId, ownAssistant)
  const assistantId = own?.id ?? null
  const name = own?.display_name ?? null
  const chrome = useMemo(() => ({
    attachGlyph: <Plus />, attachMenu,
    ...(assistantId && name ? {
      placeholder: t('chat.placeholder', { name }),
      composerHeader: <AppComposerRow ownerId={ownerId} extensionId={extensionId} assistant={{ id: assistantId, name }} chip={chip} />,
    } : {}),
  }), [attachMenu, assistantId, name, t, ownerId, extensionId, chip])
  return <ChatAreaPanel chatId={chatId} viewportKey={viewportKey} hidden={!visible} chrome={chrome} {...handlers} />
})
