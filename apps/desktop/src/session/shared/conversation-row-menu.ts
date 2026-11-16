/** Row actions of a conversation (desktop context menu and phone long-press). My agent's row is its task: session-menu.ts. */
export type ConversationRowAction = 'mark-read' | 'pin' | 'notifications' | 'mark-all-read' | 'delete-chat' | 'remove-project'
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
export type ConversationRowMenuState = ({ kind: 'chat'; canDelete: boolean | 'unknown' } | { kind: 'project' } | { kind: 'topic' }) & {
  hasUnread: boolean
  hasAnyUnread?: boolean
  pinned?: boolean
  notificationsMuted?: boolean
}

type RowMenuItem = {
  id: ConversationRowAction
  label: string
  icon: 'read' | 'pin' | 'notifications' | 'trash'
  disabled?: boolean
  danger?: boolean
  /** 收进「更多」:影响整张列表或不可撤回的,不是这一行的日常动作。 */
  fold?: true
}

export function conversationRowMenu(state: ConversationRowMenuState): RowMenuItem[] {
  const common: RowMenuItem[] = [{ id: 'mark-read', label: 'markRead', icon: 'read', disabled: !state.hasUnread }]
  if (state.kind === 'topic') return [...common, { id: 'mark-all-read', label: 'markAllRead', icon: 'read', disabled: !state.hasAnyUnread }]
  return state.kind === 'project'
    ? [...common, { id: 'remove-project', label: 'removeProject', icon: 'trash', danger: true }]
    : [...common,
        { id: 'pin', label: state.pinned ? 'unpin' : 'pin', icon: 'pin' },
        { id: 'notifications', label: state.notificationsMuted ? 'enableNotifications' : 'disableNotifications', icon: 'notifications' },
        { id: 'mark-all-read', label: 'markAllRead', icon: 'read', disabled: !state.hasAnyUnread, fold: true },
        ...(state.canDelete ? [{ id: 'delete-chat', label: 'delete', icon: 'trash', danger: true, fold: true, disabled: state.canDelete === 'unknown' } as const] : []),
      ]
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
