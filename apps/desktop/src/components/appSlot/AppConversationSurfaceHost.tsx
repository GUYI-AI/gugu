import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { observer } from 'mobx-react-lite'
import { ChatAreaPanel } from '../ChatAreaPanel'
import type { AssistantChatHandlers } from '../assistant/AssistantChatSlot'
import { Plus } from '../../lib/icons'
import { rendererLogger } from '../../lib/log'
import { useReportChatOnScreen } from '../../lib/onScreenChat'
import { installShellSlots, readShellSlots } from '../../lib/shellSlots'
import { APP_CONVERSATION_SLOT_PREFIX, installAppConversationSurfaceBridge, noteAppConversationDrawn, publishAppConversationSurfaces } from '../../lib/appConversationSurfaceBridge'
import { useAuth } from '../../store/auth'
import { useStoreValueBy } from '../../store/chatContext'
import { rpc } from '@/session/renderer/lib/ipc'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'
import type { StoredUnreadBinding } from '@/session/shared/extensions/unread-binding'

installShellSlots()
installAppConversationSurfaceBridge()

const log = rendererLogger('app-conversation-surface')
const EMPTY: ReadonlyMap<string, HTMLElement> = new Map()
// The built-in assistant's chat face (AssistantChatSlot), without what is the assistant's own: its ideas, voice notes and
// health report in the「+」, its typing line, its composer entries. The composer keeps its ordinary placeholder.
const CHROME = { attachGlyph: <Plus /> }

type Scope = { ownerId: string; inventory: object; bindings: Record<string, StoredUnreadBinding> }

/**
 * #1925 An App's main page beside the conversation its binding is bound to: the shell's half. Which conversation may be
 * drawn is the host's — the signed-in account's own selection for that installed App, `chat:surface` granted, still a member
 * (main's `grantedSurfaceBindings`) — read again on an account switch and on any change of what is installed or granted, and
 * dropped at once: the old read is not reused across either, and a conversation that left the chat list is not drawn.
 * Published to the session page (lib/appConversationSurfaceBridge.ts), which lays out the frame and leaves the column's slot;
 * the conversation itself is the ordinary native one (ChatAreaPanel), in this tree. Nothing of it reaches the App.
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
  const [scope, setScope] = useState<Scope | null>(null)
  useEffect(() => {
    if (!ownerId || !wanted) return
    let disposed = false
    void rpc.extensions.conversationSurfaceBindings({ ownerId }).then((result) => {
      if (disposed) return
      if (!result.success || result.data.ownerId !== ownerId) throw new Error('App conversation surface authority unavailable')
      setScope({ ownerId, inventory, bindings: result.data.bindings })
    }).catch((error: unknown) => {
      if (disposed) return
      setScope(null)
      log.warn({ error }, 'Could not verify App conversation surfaces')
    })
    return () => { disposed = true }
  }, [ownerId, inventory, wanted])
  const current = scope && scope.ownerId === ownerId && scope.inventory === inventory ? scope : null
  const candidates = placing.flatMap((manifest) => {
    const binding = current?.bindings[manifest.id]
    return binding && binding.ownerId === ownerId && binding.name === manifest.contributes.conversationSurface?.binding ? [[manifest.id, binding.chatId] as const] : []
  })
  // Still in it: the chat list is the account's own membership, as the rail's unread source reads it.
  const wantedChats = candidates.map(([, chatId]) => chatId)
  const present = useStoreValueBy((store) => store.chats.filter((chat) => wantedChats.includes(chat.id)).map((chat) => chat.id),
    (store) => store.chats.filter((chat) => wantedChats.includes(chat.id)).map((chat) => chat.id))
  const signature = JSON.stringify(candidates.filter(([, chatId]) => present.includes(chatId)))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is the dependency
  const surfaces = useMemo(() => Object.fromEntries(JSON.parse(signature) as [string, string][]), [signature])
  useEffect(() => { publishAppConversationSurfaces(surfaces) }, [surfaces])
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
        const chatId = surfaces[key.slice(APP_CONVERSATION_SLOT_PREFIX.length)]
        return chatId ? [createPortal(<AppConversationColumn chatId={chatId} viewportKey={key} visible={visible} {...handlers} />, element, key)] : []
      })}
    </>
  )
})

/**
 * The native conversation in the column, as the built-in assistant's (AssistantChatSlot): seen only while the slot is up and
 * the session page is on screen — the one rule read confirmation follows there. Opening the App does not confirm anything.
 */
const AppConversationColumn = memo(function AppConversationColumn({ chatId, viewportKey, visible, ...handlers }: {
  chatId: string; viewportKey: string; visible: boolean
} & AssistantChatHandlers) {
  useReportChatOnScreen(visible ? chatId : null)
  // A draft for this chat (`gugu.dispatch`) lands in this composer while it is drawn: the chat need not come up (MainLayout).
  useEffect(() => noteAppConversationDrawn(chatId), [chatId])
  return <ChatAreaPanel chatId={chatId} viewportKey={viewportKey} hidden={!visible} chrome={CHROME} {...handlers} />
})
