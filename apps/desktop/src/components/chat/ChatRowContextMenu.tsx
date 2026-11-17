import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useToast } from '../toastContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { chatsInReadScope, hasUnreadInRows, ownedAgentDmCanDelete } from '../../session/shared/conversation-row-menu'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'
import { useAuth } from '../../store/auth'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { nativeUnreadTargets } from '../../lib/nativeUnreadTargets'
import { sessionMenu, type SessionMenuAction } from '../../session/shared/session-menu'
import { MenuTableItems } from '../MenuTableItems'
import { Menu } from '../ui/Menu'
import { showModal } from '@renderer/lib/modal/modal-provider'
import { useContactsStore } from '../../store/contactsContext'
import { confirmOwnedAgentArchive } from '../../lib/archiveOwnedAgent'
import { closeIfMyAssistant } from '../../lib/assistantClose'
import { confirmConversationAction } from '../../lib/confirmDanger'
import { AliasSheet } from '../contacts/AliasSheet'

const log = rendererLogger('chat/row-menu')

export function ChatRowContextMenu({ chat, onPin, onUnpinFromSidebar, onSetNotificationLevel, onDelete, ...menu }: {
  x: number
  y: number
  chat: ChatItem
  onClose: () => void
  onPin: () => void
  /** #2548 given only for an agent row pinned to the desktop one list: the menu offers 取消固定到左侧栏. */
  onUnpinFromSidebar?: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  /** Delete my archived agent's conversation (the session table's delete-chat); only a chat-list row of a DM gives it. */
  onDelete?: () => void
}) {
  const { chats, identitiesById, markUnread, leaveGroup } = useChatStore('chats', 'identitiesById', 'markUnread', 'leaveGroup')
  const nativeRows = directoryRows(useDirectoryDevices(), useLiveDeviceSessions())
  const { user } = useAuth()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  const { updateAgentProfile, removeOwnedAgent, contacts, updateContactAlias } = useContactsStore()
  const [aliasOpen, setAliasOpen] = useState(false)
  const aliasOpening = useRef(false)
  const peer = identitiesById[chat.peer_user_id ?? '']
  const ownedAgentDm = user && peer?.type === 'agent' && peer.owner_user_id === user.id ? peer : undefined
  const friend = chat.kind === 'dm' ? contacts.find((contact) => contact.id === chat.peer_user_id && contact.type !== 'agent') : undefined
  const hasUnread = hasUnreadInRows(chatsInReadScope(chats, chat.id)) || nativeUnreadTargets(nativeRows, chatsInReadScope(chats, chat.id), false).length > 0
  const hasAnyUnread = hasUnreadInRows(chats) || nativeUnreadTargets(nativeRows, chats, true).length > 0
  // My agent's row is its task (task-name.ts): the session menu, the one table its tab and sidebar row draw from
  // (session/shared/session-menu.ts). Archive and rename go through the agent (lib/archiveOwnedAgent), which finds the
  // machine its task is on.
  if (ownedAgentDm) {
    const agentName = peer?.display_name ?? ''
    const run: Partial<Record<SessionMenuAction, () => void>> = {
      'mark-read': () => markRead(chat.id),
      'mark-unread': () => void markUnread(chat.id).catch((error: unknown) => toast(t('chatList.markUnreadFailed'), 'error', messageForUser(error))),
      pin: onPin,
      ...(onUnpinFromSidebar ? { 'sidebar-pin': onUnpinFromSidebar } : {}),
      rename: () => showModal('renameSessionModal', { sessionId: '', currentTitle: agentName, rename: (name) => updateAgentProfile(ownedAgentDm.id, { name }) }),
      notifications: () => onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none'),
      archive: () => {
        if (closeIfMyAssistant(user?.id, ownedAgentDm.id)) return // #7350 咕咕自己:换成关闭咕咕那一份确认
        void confirmOwnedAgentArchive(ownedAgentDm.id, agentName, removeOwnedAgent).then((archived) => {
          if (archived) toast(t('toast.deletedAgent', { ns: 'contacts' }), 'success')
        }, (error: unknown) => {
          log.error({ error: String(error), chatId: chat.id }, 'archive agent failed')
          toast(t('toast.deleteAgentFailed', { ns: 'contacts' }), 'error', messageForUser(error))
        })
      },
      'mark-all-read': () => markRead(),
      ...(onDelete ? { 'delete-chat': () => void confirmConversationAction('delete-chat', 'dm', agentName).then((ok) => {
        if (ok) void Promise.resolve().then(onDelete).catch((error: unknown) => {
          log.error({ error: String(error), chatId: chat.id }, 'delete chat failed')
          toast(t('chatList.deleteFailed'), 'error', messageForUser(error))
        })
      }) } : {}),
    }
    const items = sessionMenu('chat-row', {
      pinned: chat.is_pinned === true,
      sidebarPin: onUnpinFromSidebar ? 'unpin' : null,
      archived: ownedAgentDm.session_archived_at != null || ownedAgentDm.removed_at != null,
      hasUnread, hasAnyUnread,
      notificationsMuted: chat.notification_level === 'none',
      canDeleteChat: ownedAgentDmCanDelete(ownedAgentDm),
    }, new Set(Object.keys(run) as SessionMenuAction[]))
    return <Menu x={menu.x} y={menu.y} minWidth={160} onClose={menu.onClose}>
      <MenuTableItems items={items} testIdPrefix="conversation-row" onAction={(id) => { menu.onClose(); run[id]!() }} />
    </Menu>
  }
  // A person's DM: the conversation table (conversation-row-menu.ts), as their contacts row. Alias is set in its sheet, which
  // outlives the menu: choosing it keeps the menu's close request, the sheet's own close ends both.
  if (aliasOpen && friend) return <AliasSheet name={friend.display_name} alias={friend.alias} avatarUrl={friend.avatar} seed={friend.id} onSave={(alias) => updateContactAlias(friend.id, alias)} onClose={menu.onClose} />
  const name = chat.name || peer?.display_name || ''
  const leave = () => void confirmConversationAction('leave-group', chat.kind, name).then((ok) => { if (ok) void leaveGroup(chat.id).catch((error: unknown) => {
    log.error({ error: String(error), chatId: chat.id }, 'leave group failed')
    toast(t('toast.leaveFailed', { ns: 'contacts' }), 'error', messageForUser(error))
  }) })
  return <ConversationRowContextMenu {...menu} entry="chat-row"
    onClose={() => { if (!aliasOpening.current) menu.onClose() }}
    state={{ kind: chat.kind === 'group' || chat.kind === 'topic' ? chat.kind : 'dm', pinned: chat.is_pinned,
      canLeave: chat.kind === 'group' && chat.my_role != null && chat.my_role !== 'owner', friend: friend !== undefined,
      notificationsMuted: chat.notification_level === 'none', hasUnread, hasAnyUnread }}
    run={{
      'set-alias': () => { aliasOpening.current = true; setAliasOpen(true) },
      'mark-read': () => markRead(chat.id),
      'mark-unread': () => void markUnread(chat.id).catch((error: unknown) => toast(t('chatList.markUnreadFailed'), 'error', messageForUser(error))),
      'mark-all-read': () => markRead(),
      pin: onPin,
      notifications: () => onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none'),
      'leave-group': leave,
    }} />
}
