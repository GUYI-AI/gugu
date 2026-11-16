import { entryItems, type MenuExcludes, type MenuLabel, type MenuTableItem } from './menu-table'

/**
 * One action table for a conversation — a DM with a person, a group, a topic, a project's group (menu-table.ts). Its
 * chat-list row (desktop right-click, phone long-press), the topics popup of a group header, a project row and its
 * contacts row all draw from it. My agent's rows are its task: session-menu.ts.
 */
export type ConversationRowAction =
  | 'open-chat' | 'set-alias' | 'mark-read' | 'mark-unread' | 'pin' | 'notifications' | 'mark-all-read'
  | 'mark-topics-read' | 'leave-group' | 'delete-chat' | 'remove-contact' | 'remove-project'
export type ConversationMenuEntry = 'chat-row' | 'topic-popup' | 'project-row' | 'contacts' | 'contacts-group'
/** Personal DM deletion requires an archived/removed owned Agent, matching delete_my_dm_conversation. */
export function conversationCanDelete(kind: string | null, authority?: { can_dissolve?: boolean; can_archive_topic?: boolean } | null, ownedAgentDm?: { session_archived_at?: string | null; removed_at?: string | null }): boolean {
  return (kind === 'dm' && !!ownedAgentDm && (ownedAgentDm.session_archived_at != null || ownedAgentDm.removed_at != null)) || (kind === 'group' && authority?.can_dissolve === true) || (kind === 'topic' && authority?.can_archive_topic === true)
}
type RoomRow = { kind: string | null; my_role?: string | null; status?: string; source_chat_id?: string | null }
/**
 * The authority to delete a room as the conversation rows already say it, before group_info_as answers: a group is
 * dissolved by its owner (can_dissolve = group ∧ my_role = owner); a topic under a group is archived by a manager of that
 * group (can_archive_topic = topic ∧ group_is_manager: owner or admin of the group, the group not archived). `undefined`
 * when the rows do not say (a topic of a private conversation goes by its creator): the read decides.
 */
export function rowRoomCanDelete(chat: RoomRow, sourceOf: (id: string) => RoomRow | undefined): boolean | undefined {
  if (chat.kind === 'group') return chat.my_role == null ? undefined : chat.my_role === 'owner'
  const source = chat.kind === 'topic' && chat.source_chat_id ? sourceOf(chat.source_chat_id) : undefined
  if (source?.kind !== 'group' || source.my_role == null) return undefined
  return source.status !== 'archived' && (source.my_role === 'owner' || source.my_role === 'admin')
}
/** `'unknown'`: the authority to delete is not read yet — the item keeps its place, disabled, ❌ appears later. */
export type ConversationRowMenuState = {
  kind: 'dm' | 'group' | 'topic' | 'project'
  hasUnread: boolean
  hasAnyUnread?: boolean
  pinned?: boolean
  notificationsMuted?: boolean
  /** Dissolve a group, delete a topic, delete an archived agent's DM (conversationCanDelete). */
  canDelete?: boolean | 'unknown'
  /** Unread among the topics of the topic's group (the topics popup). */
  hasTopicsUnread?: boolean
  /** A group I am in and do not own: I can leave it. */
  canLeave?: boolean
  /** The DM's peer is a person who is my friend: alias and removing the contact. */
  friend?: boolean
}

export type ConversationMenuItem = MenuTableItem<ConversationRowAction>

const LEAVE_OR_DELETE_IN_CONTACTS_OR_ROW = 'Leaving and deleting are on the conversation\'s own row in the chat list and in contacts.'
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
    'leave-group': LEAVE_OR_DELETE_IN_CONTACTS_OR_ROW,
    'delete-chat': LEAVE_OR_DELETE_IN_CONTACTS_OR_ROW,
  },
  'project-row': {
    'open-chat': 'Clicking the row opens it.',
    'mark-unread': PROJECT_ROW,
    pin: PROJECT_ROW,
    notifications: PROJECT_ROW,
    'mark-all-read': 'Acts on the whole chat list, not on the project list.',
    'mark-topics-read': 'Only the topics popup lists one group\'s topics.',
    'leave-group': PROJECT_ROW,
    'delete-chat': PROJECT_ROW,
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
const DELETE_LABEL = { dm: 'chatList.deleteChat', group: 'chatList.dissolveGroup', topic: 'chatList.deleteTopic' } as const

/** The whole table, in order, before any entry leaves anything out. */
function allItems(state: ConversationRowMenuState): ConversationMenuItem[] {
  const items: ConversationMenuItem[] = [{ id: 'open-chat', label: contacts('contextMenu.startChat'), icon: 'chat' }]
  if (state.friend) items.push({ id: 'set-alias', label: contacts('contextMenu.setAlias'), icon: 'alias' })
  // Read state is one row: mark read while something is unread, mark unread otherwise.
  items.push(state.hasUnread
    ? { id: 'mark-read', label: messaging('chatList.markRead'), icon: 'read' }
    : { id: 'mark-unread', label: contacts('contextMenu.markUnread'), icon: 'unread' })
  if (state.kind === 'project') {
    items.push({ id: 'remove-project', label: messaging('chatList.removeProject'), icon: 'trash', danger: true })
    return items
  }
  items.push(
    { id: 'pin', label: messaging(state.pinned ? 'chatList.unpin' : 'chatList.pin'), icon: state.pinned ? 'unpin' : 'pin' },
    { id: 'notifications', label: messaging(state.notificationsMuted ? 'chatList.enableNotifications' : 'chatList.disableNotifications'), icon: 'bell' },
    { id: 'mark-all-read', label: messaging('chatList.markAllRead'), icon: 'read', fold: true, disabled: !state.hasAnyUnread },
  )
  // The group's topics, as one list: only a list of one group's topics offers it (the topics popup).
  if (state.kind === 'topic') items.push({ id: 'mark-topics-read', label: messaging('chatList.markTopicsRead'), icon: 'read', fold: true, disabled: !state.hasTopicsUnread })
  if (state.kind === 'group' && state.canLeave) items.push({ id: 'leave-group', label: messaging('chatList.leaveGroup'), icon: 'leave', fold: true, danger: true })
  if (state.canDelete) items.push({ id: 'delete-chat', label: messaging(DELETE_LABEL[state.kind]), icon: 'trash', fold: true, danger: true, disabled: state.canDelete === 'unknown' })
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
