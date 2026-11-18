import type { PersonalConversationHiding } from '../../lib/hideListedConversation'
import { currentAuthSessionSignal } from '../../lib/authSessionLoss'
import { showConversationHideNotice } from '../../lib/conversationHideNotice'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { ChatItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
import { useToast } from '../toastContext'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { chatsInReadScope, conversationCanHide, hasUnreadInRows, personalConversationMenu, type PersonalConversationAction, type PersonalConversationMenuState } from '../../session/shared/conversation-row-menu'
import { directoryRows, useDirectoryDevices, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { nativeUnreadTargets } from '../../lib/nativeUnreadTargets'
import { confirmDeleteConversation } from '../../lib/confirmDeleteConversation'
import { messageForUser } from '../../lib/userFacingError'
import { BellOff, CheckCircle, EyeOff, MoreHorizontal, PanelLeftClose, Pin, Trash } from '@/lib/icons'
import { Menu, MenuFold, MenuItem, MenuSeparator } from '../ui/Menu'

/** Explicit hide callback prevents a personal menu from accidentally invoking group archival. */
export function PersonalConversationRowMenu({ chat, onPin, onUnpinFromSidebar, onSetNotificationLevel, onHide, ...menu }: {
  x: number
  y: number
  chat: ChatItem
  onClose: () => void
  onPin: () => void
  onUnpinFromSidebar?: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onHide: () => Promise<PersonalConversationHiding | undefined>
}) {
  const { chats, identitiesById, clearConversation, undoConversationHide } = useChatStore('chats', 'identitiesById', 'clearConversation', 'undoConversationHide')
  const nativeRows = directoryRows(useDirectoryDevices(), useLiveDeviceSessions())
  const { user } = useAuth()
  const { removeOwnedAgent } = useContactsStore()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  const peer = identitiesById[chat.peer_user_id ?? '']
  const owned = (chat.kind === 'dm' || chat.kind === 'ai') && user && peer?.type === 'agent'
    && peer.owner_user_id === user.id && !peer.removed_at ? peer : undefined
  const scope = chatsInReadScope(chats, chat.id)
  return <PersonalConversationContextMenu {...menu} state={{
    canDelete: conversationCanHide(chat.kind), pinned: chat.is_pinned, pinnedToSidebar: onUnpinFromSidebar !== undefined,
    notificationsMuted: chat.notification_level === 'none',
    hasUnread: hasUnreadInRows(scope) || nativeUnreadTargets(nativeRows, scope, false).length > 0,
    hasAnyUnread: hasUnreadInRows(chats) || nativeUnreadTargets(nativeRows, chats, true).length > 0 }}
    onAction={(action) => {
      if (action === 'mark-read') markRead(chat.id)
      else if (action === 'mark-all-read') markRead()
      else if (action === 'pin') onPin()
      else if (action === 'unpin-from-sidebar') onUnpinFromSidebar!()
      else if (action === 'notifications') onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none')
      else if (action === 'hide-chat') {
        const boundary = currentAuthSessionSignal()
        void onHide().then(receipt => {
          if (receipt && user) showConversationHideNotice({ accountId: user.id, name: chatDisplayName(chat, peer?.display_name), receipt, boundary,
            undo: () => undoConversationHide(chat.id, receipt.operation_id) })
        }).catch((error: unknown) => toast(t('chatList.hideFailed'), 'error', messageForUser(error)))
      }
      else if (action === 'delete-chat') void confirmDeleteConversation({ name: chatDisplayName(chat, peer?.display_name), clear: () => clearConversation(chat.id),
        ownedAgent: owned ? { id: owned.id, remove: () => removeOwnedAgent(owned.id, { removeSocialIdentity: true }) } : undefined,
      }).catch((error: unknown) => toast(t('chatList.deleteFailed'), 'error', messageForUser(error)))
    }} />
}

const icons = { read: CheckCircle, pin: Pin, sidebar: PanelLeftClose, notifications: BellOff, hide: EyeOff, trash: Trash }
function PersonalConversationContextMenu({ x, y, state, onClose, onAction }: {
  x: number; y: number; state: PersonalConversationMenuState; onClose: () => void; onAction: (action: PersonalConversationAction) => void
}) {
  const { t } = useTranslation('messaging')
  const items = personalConversationMenu(state)
  const row = (item: typeof items[number]) => {
    const Icon = icons[item.icon]
    return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
      data-testid={item.id === 'mark-all-read' ? 'chat-row-mark-all-read' : `conversation-row-${item.id}`}
      onClick={() => { onClose(); onAction(item.id) }}>{t(`chatList.${item.label}`)}</MenuItem>
  }
  return <Menu x={x} y={y} minWidth={200} onClose={onClose}>
    {items.filter(item => !item.fold && !item.danger).map(row)}
    {items.some(item => item.fold) ? <MenuFold icon={<MoreHorizontal size={15} />} label={t('message.actions.more')} data-testid="conversation-row-more">{items.filter(item => item.fold).map(row)}</MenuFold> : null}
    {items.some(item => item.danger) && <MenuSeparator />}
    {items.filter(item => item.danger).map(row)}
  </Menu>
}
