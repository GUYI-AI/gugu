import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useToast } from '../toastContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { chatsInReadScope, conversationCanDelete, hasUnreadInRows, rowRoomCanDelete } from '../../session/shared/conversation-row-menu'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { useGroupChatSettings } from './useGroupChatSettings'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'
import { useAuth } from '../../store/auth'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { nativeUnreadTargets } from '../../lib/nativeUnreadTargets'
import { sessionMenu, type SessionMenuAction } from '../../session/shared/session-menu'
import { SessionMenuItems } from '../SessionMenuItems'
import { Menu } from '../ui/Menu'
import { showModal } from '@renderer/lib/modal/modal-provider'
import { useContactsStore } from '../../store/contactsContext'
import { confirmOwnedAgentArchive } from '../../lib/archiveOwnedAgent'
import { closeIfMyAssistant } from '../../lib/assistantClose'

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
  onDelete: () => void
}) {
  const { chats, identitiesById } = useChatStore('chats', 'identitiesById')
  const nativeRows = directoryRows(useDirectoryDevices(), useLiveDeviceSessions())
  const { user } = useAuth()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  const { updateAgentProfile, removeOwnedAgent } = useContactsStore()
  const { settings, error } = useGroupChatSettings(chat.kind === 'group' || chat.kind === 'topic' ? chat.id : null)
  const peer = identitiesById[chat.peer_user_id ?? '']
  const ownedAgentDm = user && peer?.type === 'agent' && peer.owner_user_id === user.id ? peer : undefined
  const room = chat.kind === 'group' || chat.kind === 'topic'
  // A room's authority not read yet: the rows' roles draw the menu's shape from the first frame (CH5: the delete item used
  // to appear, or vanish, after the read); only when the rows do not say does the item keep its place, disabled.
  const canDelete = room && settings === null && !error
    ? rowRoomCanDelete(chat, (id) => chats.find((row) => row.id === id)) ?? 'unknown' as const
    : conversationCanDelete(chat.kind, settings, ownedAgentDm)
  const hasUnread = hasUnreadInRows(chatsInReadScope(chats, chat.id)) || nativeUnreadTargets(nativeRows, chatsInReadScope(chats, chat.id), false).length > 0
  const hasAnyUnread = hasUnreadInRows(chats) || nativeUnreadTargets(nativeRows, chats, true).length > 0
  const remove = () => void Promise.resolve().then(onDelete).catch((error: unknown) => {
    log.error({ error: String(error), chatId: chat.id }, 'delete chat failed')
    toast(t('chatList.deleteFailed'), 'error', messageForUser(error))
  })
  // My agent's row is its task (task-name.ts): the session menu, the one table its tab and sidebar row draw from
  // (session/shared/session-menu.ts). Archive and rename go through the agent (lib/archiveOwnedAgent), which finds the
  // machine its task is on.
  if (ownedAgentDm) {
    const agentName = peer?.display_name ?? ''
    const run: Partial<Record<SessionMenuAction, () => void>> = {
      'mark-read': () => markRead(chat.id),
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
      'delete-chat': remove,
    }
    const items = sessionMenu('chat-row', {
      pinned: chat.is_pinned === true,
      sidebarPin: onUnpinFromSidebar ? 'unpin' : null,
      archived: ownedAgentDm.session_archived_at != null || ownedAgentDm.removed_at != null,
      hasUnread, hasAnyUnread,
      notificationsMuted: chat.notification_level === 'none',
      canDeleteChat: conversationCanDelete(chat.kind, null, ownedAgentDm),
    }, new Set(Object.keys(run) as SessionMenuAction[]))
    return <Menu x={menu.x} y={menu.y} minWidth={160} onClose={menu.onClose}>
      <SessionMenuItems items={items} testIdPrefix="conversation-row" onAction={(id) => { menu.onClose(); run[id]!() }} />
    </Menu>
  }
  return <ConversationRowContextMenu {...menu} loadError={error} state={{ kind: 'chat', canDelete, pinned: chat.is_pinned,
    notificationsMuted: chat.notification_level === 'none',
    hasUnread, hasAnyUnread }}
    onAction={(action) => {
      if (action === 'mark-read') markRead(chat.id)
      else if (action === 'mark-all-read') markRead()
      else if (action === 'pin') onPin()
      else if (action === 'notifications') onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none')
      // 解散影响全体成员、撤不回:和群设置、联系人那两处解散同一句确认。
      else if (action === 'delete-chat' && canDelete === true && (chat.kind !== 'group' || window.confirm(t('group.settings.dissolveConfirm')))) remove()
    }} />
}
