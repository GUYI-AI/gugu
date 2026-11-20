import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import type { ContactRowMenuActions } from './ContactRowActions'
import { GroupSectionRow, PersonContactRow } from './ContactRowItems'
import { ct } from './contactsPanelStyles'

// 通讯录分组页 / 搜索里人行、群行、agent 右键菜单要的那一份选中态与动作:ContactsPanel 给一次,各处读这里。
/** 一个分组里每种行要的那一份选中态与动作(右键菜单同款 chat-scoped 动作,#886 / #1694)。由 ContactsPanel 给一次。 */
export type ContactsRowHandlers = {
  currentUserId?: string | null
  selectedContactId: string | null
  selectedGroupId: string | null
  selectionMode: boolean
  selectedContactIds: Set<string>
  onSelectContact: (c: ContactUser) => void
  onToggleContact: (c: ContactUser) => void
  onSelectGroup: (g: ContactGroupChat) => void
  onStartChat?: (contact: ContactUser) => void
  onPin?: (contact: ContactUser) => void
  onMarkUnread?: (contact: ContactUser) => void
  onToggleNotif?: (contact: ContactUser) => void
  onRemove?: (contact: ContactUser) => void
  contactPinned?: Map<string, boolean>
  contactNotifMuted?: Map<string, boolean>
  getContactRemoveLabel: (contact: ContactUser) => string
  onGroupPin?: (g: ContactGroupChat) => void
  onGroupToggleNotif?: (g: ContactGroupChat) => void
  onGroupLeave?: (g: ContactGroupChat) => void
  groupPinned?: Map<string, boolean>
  groupNotifMuted?: Map<string, boolean>
}

export function useContactRowRenderers(h: ContactsRowHandlers) {
  const hasContactMenu = !!(h.onPin && h.onMarkUnread && h.onToggleNotif && h.onRemove)
  const contactMenu = (c: ContactUser): ContactRowMenuActions | undefined => !hasContactMenu ? undefined : {
    removeLabel: h.getContactRemoveLabel(c), contact: c, // #5645 → 「设置备注」
    onStartChat: h.onStartChat ? () => h.onStartChat!(c) : undefined,
    isPinned: h.contactPinned?.get(c.id) ?? false,
    notifMuted: h.contactNotifMuted?.get(c.id) ?? false,
    onPin: () => h.onPin!(c), onMarkUnread: () => h.onMarkUnread!(c), onToggleNotif: () => h.onToggleNotif!(c), onRemove: () => h.onRemove!(c),
  }
  // 解散群聊不进右键(menu-table.ts @@@menu-order),只在群设置页最底下;成员的「退出群聊」确认 + 动作在父层 onGroupLeave。
  const groupMenu = (g: ContactGroupChat): ContactRowMenuActions | undefined => !(h.onGroupPin && h.onGroupToggleNotif && h.onGroupLeave) ? undefined : {
    removeLabel: ct('contextMenu.leaveGroup'), group: { chatId: g.id, role: g.my_role, name: g.name },
    isPinned: h.groupPinned?.get(g.id) ?? false,
    notifMuted: h.groupNotifMuted?.get(g.id) ?? g.is_muted,
    onPin: () => h.onGroupPin!(g), onToggleNotif: () => h.onGroupToggleNotif!(g), onRemove: () => h.onGroupLeave!(g),
  }
  const pinnedContact = (c: ContactUser) => h.contactPinned?.get(c.id) ?? false
  const pinnedGroup = (g: ContactGroupChat) => h.groupPinned?.get(g.id) ?? false
  return {
    /** 一个 agent / 人的右键菜单(没有菜单动作 = undefined);自己的 agent 才给。 */
    agentMenu: (c: ContactUser) => (c.owner_user_id === h.currentUserId ? contactMenu(c) : undefined),
    renderPerson: (c: ContactUser) => (
      <PersonContactRow
        key={c.id} contact={c}
        selected={c.id === h.selectedContactId}
        multiSelected={h.selectedContactIds.has(c.id)}
        selectionMode={h.selectionMode}
        pinned={pinnedContact(c)}
        onSelect={() => h.onSelectContact(c)}
        onToggleSelection={() => h.onToggleContact(c)}
        menu={contactMenu(c)}
      />
    ),
    renderGroup: (g: ContactGroupChat) => (
      <GroupSectionRow key={g.id} group={g} selected={g.id === h.selectedGroupId} pinned={pinnedGroup(g)} onSelect={() => h.onSelectGroup(g)} menu={groupMenu(g)} />
    ),
  }
}
