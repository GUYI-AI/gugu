import { entryItems, type MenuExcludes, type MenuLabel, type MenuTableItem } from './menu-table'

/**
 * One action table for a conversation — a DM with a person, a group, a topic, a project's group (menu-table.ts). Its
 * chat-list row (desktop right-click, phone long-press), the topics popup of a group header, a project row and its
 * contacts row all draw from it. My agent's rows are its task: session-menu.ts.
 *
 * Dissolving a group and deleting a topic are in no menu (menu-table.ts @@@menu-order, rule 4): rare, irreversible and
 * felt by every member, they are at the bottom of the group's settings page and of the topic's members page.
 */
export type ConversationRowAction =
  | 'open-chat' | 'set-alias' | 'mark-read' | 'mark-unread' | 'pin' | 'notifications' | 'mark-all-read'
  | 'mark-topics-read' | 'leave-group' | 'remove-contact' | 'remove-project'
export type ConversationMenuEntry = 'chat-row' | 'topic-popup' | 'project-row' | 'contacts' | 'contacts-group'
/** Deleting my agent's DM (the session table's delete-chat) requires it archived or removed, matching delete_my_dm_conversation. */
export function ownedAgentDmCanDelete(ownedAgentDm: { session_archived_at?: string | null; removed_at?: string | null }): boolean {
  return ownedAgentDm.session_archived_at != null || ownedAgentDm.removed_at != null
}
export type ConversationRowMenuState = {
  kind: 'dm' | 'group' | 'topic' | 'project'
  hasUnread: boolean
  hasAnyUnread?: boolean
  pinned?: boolean
  notificationsMuted?: boolean
  /** Unread among the topics of the topic's group (the topics popup). */
  hasTopicsUnread?: boolean
  /** A group I am in and do not own: I can leave it. */
  canLeave?: boolean
  /** The DM's peer is a person who is my friend: alias and removing the contact. */
  friend?: boolean
}

export type ConversationMenuItem = MenuTableItem<ConversationRowAction>

const LEAVE_IN_CONTACTS_OR_ROW = 'Leaving is on the group\'s own row in the chat list and in contacts.'
const PROJECT_ROW = 'The project row stands for the project; its conversation\'s own actions are on its chat-list row.'
/** The actions an entry leaves out, each with its reason. */
export const CONVERSATION_MENU_EXCLUDES: MenuExcludes<ConversationMenuEntry, ConversationRowAction> = {
  'chat-row': {
    'open-chat': 'Clicking the row opens it.',
    'mark-topics-read': 'Only the topics popup lists one group\'s topics.',
    'remove-contact': 'Removing a friend is a change to the contact, offered where the person is listed (contacts); the chat row deletes conversations only.',
  },
  'topic-popup': {
    'open-chat': 'Clicking the row opens it.',
    'mark-unread': 'The popup is a quick reader of the group\'s topics.',
    'mark-all-read': 'The popup marks its own topics read (mark-topics-read); the whole chat list is marked from the chat list.',
    pin: 'The popup has its own topic pin, the icon on each row (it orders the topics in this popup).',
    notifications: 'The popup is a quick reader of the group\'s topics; notifications are on the topic\'s chat-list row.',
    'leave-group': LEAVE_IN_CONTACTS_OR_ROW,
  },
  'project-row': {
    'open-chat': 'Clicking the row opens it.',
    'mark-unread': PROJECT_ROW,
    pin: PROJECT_ROW,
    notifications: PROJECT_ROW,
    'mark-all-read': 'Acts on the whole chat list, not on the project list.',
    'mark-topics-read': 'Only the topics popup lists one group\'s topics.',
    'leave-group': PROJECT_ROW,
  },
  contacts: {
    'mark-all-read': 'Acts on the whole chat list, not on this contact.',
    'mark-topics-read': 'Only the topics popup lists one group\'s topics.',
  },
  'contacts-group': {
    'open-chat': 'Clicking a group row in contacts opens the group\'s page, whose first button enters the chat.',
    'mark-all-read': 'Acts on the whole chat list, not on this group.',
    'mark-topics-read': 'Only the topics popup lists one group\'s topics.',
  },
}

const messaging = (key: string): MenuLabel => ({ ns: 'messaging', key })
const contacts = (key: string): MenuLabel => ({ ns: 'contacts', key })

/**
 * The whole table, in order, before any entry leaves anything out. Ordered by menu-table.ts @@@menu-order; there is no
 * click data, so each row says why it sits where it does.
 */
function allItems(state: ConversationRowMenuState): ConversationMenuItem[] {
  const items: ConversationMenuItem[] = [
    // Message: what a contacts row is opened for (excluded wherever clicking the row already opens it).
    { id: 'open-chat', label: contacts('contextMenu.startChat'), icon: 'chat' },
    // Read state, one row: mark read while something is unread, mark unread otherwise. Several times a day, triaging.
    state.hasUnread
      ? { id: 'mark-read', label: messaging('chatList.markRead'), icon: 'read' }
      : { id: 'mark-unread', label: contacts('contextMenu.markUnread'), icon: 'unread' },
  ]
  if (state.kind === 'project') {
    // Remove the project: rare and destructive, asks first; the project row's only other action (a short menu).
    items.push({ id: 'remove-project', label: messaging('chatList.removeProject'), icon: 'trash', danger: true })
    return items
  }
  items.push(
    // Pin: a few times a week, keeping the conversations in hand at the top.
    { id: 'pin', label: messaging(state.pinned ? 'chatList.unpin' : 'chatList.pin'), icon: state.pinned ? 'unpin' : 'pin' },
    // Notifications: about weekly, muting a group that got noisy (and back).
    { id: 'notifications', label: messaging(state.notificationsMuted ? 'chatList.enableNotifications' : 'chatList.disableNotifications'), icon: 'bell' },
  )
  // 更多 — alias: set once per friend.
  if (state.friend) items.push({ id: 'set-alias', label: contacts('contextMenu.setAlias'), icon: 'alias', fold: true })
  // 更多 — mark all read: acts on the whole chat list, not on this row.
  items.push({ id: 'mark-all-read', label: messaging('chatList.markAllRead'), icon: 'read', fold: true, disabled: !state.hasAnyUnread })
  // 更多 — the group's topics, as one list: only a list of one group's topics offers it (the topics popup).
  if (state.kind === 'topic') items.push({ id: 'mark-topics-read', label: messaging('chatList.markTopicsRead'), icon: 'read', fold: true, disabled: !state.hasTopicsUnread })
  // 更多, last — leaving a group or removing a friend: rare and destructive (back only by being invited or added
  // again), asks first.
  if (state.kind === 'group' && state.canLeave) items.push({ id: 'leave-group', label: messaging('chatList.leaveGroup'), icon: 'leave', fold: true, danger: true })
  if (state.friend) items.push({ id: 'remove-contact', label: contacts('contextMenu.deleteContact'), icon: 'trash', fold: true, danger: true })
  return items
}

/** The menu one entry shows: the table minus that entry's documented exclusions (menu-table.ts `entryItems`). */
export function conversationMenu(entry: ConversationMenuEntry, state: ConversationRowMenuState, handled: ReadonlySet<ConversationRowAction>): ConversationMenuItem[] {
  return entryItems('Conversation', entry, allItems(state), CONVERSATION_MENU_EXCLUDES, handled)
}

type ChatScopeRow = { id: string; kind: string | null; source_chat_id?: string | null }

/** Include the selected conversations and their topic descendants, never their siblings or ancestors. */
export function chatsInReadScope<T extends ChatScopeRow>(chats: readonly T[], rootId: string | readonly string[]): T[] {
  const children = new Map<string, T[]>()
  for (const chat of chats) {
    if (chat.kind !== 'topic' || !chat.source_chat_id) continue
    const siblings = children.get(chat.source_chat_id) ?? []
    siblings.push(chat)
    children.set(chat.source_chat_id, siblings)
  }
  const ids = new Set(typeof rootId === 'string' ? [rootId] : rootId)
  for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child.id)
  return chats.filter((chat) => ids.has(chat.id))
}

export function hasUnreadInRows(rows: readonly { unread_count: number; is_marked_unread?: boolean }[]): boolean {
  return rows.some((row) => row.unread_count > 0 || row.is_marked_unread === true)
}

/** Personal list actions do not archive the task, leave its group or remove its contact. */
export function conversationCanHide(kind: string | null): boolean {
  return kind === 'dm' || kind === 'ai' || kind === 'group' || kind === 'topic'
}
export type PersonalConversationAction = 'pin' | 'mark-read' | 'notifications' | 'hide-chat' | 'mark-all-read' | 'unpin-from-sidebar' | 'delete-chat'
export type PersonalConversationMenuState = {
  canDelete: boolean; pinned?: boolean; pinnedToSidebar?: boolean; notificationsMuted?: boolean
  hasUnread: boolean; hasAnyUnread?: boolean
}
export function personalConversationMenu(state: PersonalConversationMenuState): {
  id: PersonalConversationAction; label: string; icon: 'pin' | 'read' | 'notifications' | 'hide' | 'sidebar' | 'trash'; disabled?: boolean; fold?: boolean; danger?: boolean
}[] {
  return [
    { id: 'pin', label: state.pinned ? 'unpin' : 'pin', icon: 'pin' },
    { id: 'mark-read', label: 'markRead', icon: 'read', disabled: !state.hasUnread },
    { id: 'notifications', label: state.notificationsMuted ? 'enableNotifications' : 'disableNotifications', icon: 'notifications' },
    ...(state.canDelete ? [{ id: 'hide-chat', label: 'hide', icon: 'hide' } as const] : []),
    ...(state.pinnedToSidebar ? [{ id: 'unpin-from-sidebar', label: 'unpinFromSidebar', icon: 'sidebar', fold: true } as const] : []),
    ...(state.canDelete ? [{ id: 'delete-chat', label: 'clearHistory', icon: 'trash', danger: true } as const] : []),
  ]
}
