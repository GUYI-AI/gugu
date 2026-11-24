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
import { confirmOwnedAgentArchive } from '../../lib/archiveOwnedAgent'
import { closeIfMyAssistant } from '../../lib/assistantClose'
import { rendererLogger } from '../../lib/log'
import { messageForUser } from '../../lib/userFacingError'
import { MoreHorizontal } from '@/lib/icons'
import { Menu, MenuFold, MenuItem, MenuSeparator } from '../ui/Menu'
import { menuTableIcon, menuTableLabel } from '../menuTablePresentation'
import { showModal } from '@renderer/lib/modal/modal-provider'

const log = rendererLogger('chat/row-menu')

/** A chat-list row's menu (desktop right-click, phone long-press). Explicit hide callback prevents a personal menu from accidentally invoking group archival. */
export function ChatRowContextMenu({ chat, onPin, onUnpinFromSidebar, onLeaveSplit, onSetNotificationLevel, onHide, ...menu }: {
  x: number
  y: number
  chat: ChatItem
  onClose: () => void
  onPin: () => void
  /** #2548 given only for an agent row pinned to the desktop one list: the menu offers 取消固定到左侧栏. */
  onUnpinFromSidebar?: () => void
  /** Given only while the conversation is a block of a split screen: the menu offers 取消并排. */
  onLeaveSplit?: () => void
  onSetNotificationLevel: (level: NotificationLevel) => void
  onHide: () => Promise<PersonalConversationHiding | undefined>
}) {
  const { chats, identitiesById, clearConversation, undoConversationHide } = useChatStore('chats', 'identitiesById', 'clearConversation', 'undoConversationHide')
  const nativeRows = directoryRows(useDirectoryDevices(), useLiveDeviceSessions())
  const { user } = useAuth()
  const { removeOwnedAgent, updateAgentProfile } = useContactsStore()
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const markRead = useMarkChatsRead()
  const peer = identitiesById[chat.peer_user_id ?? '']
  const agent = (chat.kind === 'dm' || chat.kind === 'ai') && peer?.type === 'agent'
  const ownedAgent = agent && user && peer.owner_user_id === user.id && !peer.removed_at ? peer : undefined
  const archivable = ownedAgent && !ownedAgent.session_archived_at ? ownedAgent : undefined
  const name = chatDisplayName(chat, peer?.display_name)
  const scope = chatsInReadScope(chats, chat.id)
  return <PersonalConversationContextMenu {...menu} state={{
    canDelete: conversationCanHide(chat.kind), pinned: chat.is_pinned, pinnedToSidebar: onUnpinFromSidebar !== undefined,
    notificationsMuted: chat.notification_level === 'none', agent, canRenameAgent: ownedAgent !== undefined, canArchive: archivable !== undefined,
    hasUnread: hasUnreadInRows(scope) || nativeUnreadTargets(nativeRows, scope, false).length > 0, inSplit: onLeaveSplit !== undefined }}
    onAction={(action) => {
      if (action === 'mark-read') markRead(chat.id)
      else if (action === 'pin') onPin()
      else if (action === 'unpin-from-sidebar') onUnpinFromSidebar!()
      else if (action === 'leave-split') onLeaveSplit!()
      else if (action === 'notifications') onSetNotificationLevel(chat.notification_level === 'none' ? 'all' : 'none')
      else if (action === 'hide-chat') {
        const boundary = currentAuthSessionSignal()
        void onHide().then(receipt => {
          if (receipt && user) showConversationHideNotice({ accountId: user.id, name, receipt, boundary,
            undo: () => undoConversationHide(chat.id, receipt.operation_id) })
        }).catch((error: unknown) => toast(t('chatList.hideFailed'), 'error', messageForUser(error)))
      }
      else if (action === 'rename-agent' && ownedAgent) showModal('renameSessionModal', {
        sessionId: '',
        currentTitle: ownedAgent.display_name,
        rename: (name) => updateAgentProfile(ownedAgent.id, { name }),
        labels: {
          title: t('agentName.editAction', { ns: 'contacts' }),
          field: t('agentName.label', { ns: 'contacts' }),
        },
      })
      // My agent's archive, through the one agent archive confirmation (lib/archiveOwnedAgent), as contacts and its settings.
      else if (action === 'archive') {
        if (closeIfMyAssistant(user?.id, archivable!.id)) return // #7350 咕咕自己:换成关闭咕咕那一份确认
        void confirmOwnedAgentArchive(archivable!.id, name, removeOwnedAgent).then((archived) => {
          if (archived) toast(t('toast.deletedAgent', { ns: 'contacts' }), 'success')
        }, (error: unknown) => {
          log.error({ error: String(error), chatId: chat.id }, 'archive agent failed')
          toast(t('toast.deleteAgentFailed', { ns: 'contacts' }), 'error', messageForUser(error))
        })
      }
      else if (action === 'delete-chat') void confirmDeleteConversation({ name, clear: () => clearConversation(chat.id) })
        .catch((error: unknown) => toast(t('chatList.deleteFailed'), 'error', messageForUser(error)))
    }} />
}

function PersonalConversationContextMenu({ x, y, state, onClose, onAction }: {
  x: number; y: number; state: PersonalConversationMenuState; onClose: () => void; onAction: (action: PersonalConversationAction) => void
}) {
  const { t } = useTranslation('messaging')
  const items = personalConversationMenu(state)
  const row = (item: typeof items[number]) => {
    const Icon = menuTableIcon(item.icon)
    return <MenuItem key={item.id} icon={<Icon size={15} />} danger={item.danger} disabled={item.disabled}
      data-testid={`conversation-row-${item.id}`}
      onClick={() => { onClose(); onAction(item.id) }}>{menuTableLabel(item.label)}</MenuItem>
  }
  return <Menu x={x} y={y} minWidth={200} onClose={onClose}>
    {items.filter(item => !item.fold && !item.danger).map(row)}
    {items.some(item => item.fold) ? <MenuFold icon={<MoreHorizontal size={15} />} label={t('message.actions.more')} data-testid="conversation-row-more">{items.filter(item => item.fold).map(row)}</MenuFold> : null}
    {items.some(item => item.danger) && <MenuSeparator />}
    {items.filter(item => item.danger).map(row)}
  </Menu>
}
