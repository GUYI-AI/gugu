/**
 * One action table for a session — and for my agent, whose name and task are that session (task-name.ts). Every menu
 * that shows it — its tab, its sidebar row, its chat-list row, the phone's session menu — draws from this table:
 * the same actions, the same names, the same order, the same fold. An entry only says which actions do not apply
 * where it is, and why ({@link SESSION_MENU_EXCLUDES}); it never adds, renames or reorders one.
 *
 * Kept free of renderer imports (like conversation-row-menu.ts) so the chat list, the task page and the phone share it.
 */

export type SessionMenuAction =
  | 'mark-read'
  | 'pin'
  | 'sidebar-pin'
  | 'rename'
  | 'notifications'
  | 'archive'
  | 'fork'
  | 'copy-id'
  | 'reload'
  | 'legacy-history'
  | 'mark-all-read'
  | 'delete-chat'

export type SessionMenuEntry = 'tab' | 'sidebar-row' | 'chat-row' | 'phone'

/** A label in the catalog it lives in: `session` = the task page's messages, `messaging` = the chat namespace. */
export type SessionMenuLabel = { ns: 'session' | 'messaging'; key: string }

export type SessionMenuItem = {
  id: SessionMenuAction
  label: SessionMenuLabel
  icon: 'read' | 'pin' | 'unpin' | 'sidebar' | 'sidebar-off' | 'rename' | 'bell' | 'archive' | 'fork' | 'copy' | 'reload' | 'history' | 'trash'
  /** Into 更多: low-frequency, or acts on more than this one row. */
  fold?: true
  danger?: true
  disabled?: boolean
}

export type SessionMenuState = {
  /** 置顶 acts on the row this agent shows as in the left list (see {@link SessionMenuPin}). */
  pinned: boolean
  /** 固定到左侧栏: null = not offered (a child session never is a row of the left list). */
  sidebarPin: 'pin' | 'unpin' | null
  /** The task is already archived: archive gives way to deleting the conversation. */
  archived?: boolean
  hasUnread?: boolean
  hasAnyUnread?: boolean
  notificationsMuted?: boolean
  /** Forking needs the harness to support it on this runtime. */
  canFork?: boolean
  /** Restarting is unavailable while one is in flight. */
  reloading?: boolean
  /** The legacy DM history exists for this agent. */
  hasLegacyHistory?: boolean
  /** The conversation may be deleted (an archived owned agent's DM): `'unknown'` keeps the place, disabled. */
  canDeleteChat?: boolean | 'unknown'
}

/**
 * What 置顶 pins: the row this agent shows as in the left list. A session with a row in a project's list is pinned in
 * that list (the session's pin); an agent that only shows as a chat-list row is pinned among the conversations (the
 * chat's pin). One 置顶 per menu, whichever entry opened it (#2548: 置顶 orders a row first within the list it is in).
 */
export type SessionMenuPin = 'session' | 'chat'

/**
 * The actions an entry leaves out, each with its reason. A test pins that every reason is non-empty; an entry with no
 * handler for an action that is not listed here throws when the menu is built — fail loud, ❌ silently missing.
 */
export const SESSION_MENU_EXCLUDES: Record<SessionMenuEntry, Partial<Record<SessionMenuAction, string>>> = {
  tab: {
    'mark-read': 'The tab is open: what it shows is being read.',
    notifications: 'Notifications belong to the conversation; its settings are one click away in the chat page.',
    'mark-all-read': 'Acts on the whole chat list, not on this tab.',
    'delete-chat': 'An open tab is a live task; deleting the conversation is offered only once the agent is archived, from the chat list.',
  },
  'sidebar-row': {
    'mark-read': 'A project task row has no conversation of its own to mark read.',
    notifications: 'A project task row has no conversation of its own to mute.',
    reload: 'Restarting asks through the session page confirmation, which lives with the open session.',
    'legacy-history': 'The legacy history dialog lives with the open session page.',
    'mark-all-read': 'Acts on the whole chat list, not on the project list.',
    'delete-chat': 'A project task row has no conversation of its own to delete.',
  },
  'chat-row': {
    fork: 'The row may stand for a task on another machine; forking needs the task on this one.',
    'copy-id': 'The row may stand for a task on another machine; its session id is not known here without opening it.',
    reload: 'Restarting needs the task mounted on this machine.',
    'legacy-history': 'The legacy history dialog lives with the open session page.',
  },
  phone: {
    'mark-read': 'The phone session list has no conversation unread state.',
    notifications: 'The phone session list has no conversation notification setting.',
    'sidebar-pin': 'The left list is desktop only.',
    fork: 'The phone has no fork call to the task host.',
    'copy-id': 'Session ids are a desktop tool.',
    reload: 'The phone has no restart call to the task host.',
    'legacy-history': 'The legacy history dialog is desktop only.',
    'mark-all-read': 'The phone session list has no conversation unread state.',
    'delete-chat': 'Deleting a conversation is in the phone chat list.',
  },
}

const session = (key: string): SessionMenuLabel => ({ ns: 'session', key })
const messaging = (key: string): SessionMenuLabel => ({ ns: 'messaging', key })

/** The whole table, in order, before any entry leaves anything out. */
function allItems(state: SessionMenuState): SessionMenuItem[] {
  const items: SessionMenuItem[] = [
    { id: 'mark-read', label: messaging('chatList.markRead'), icon: 'read', disabled: !state.hasUnread },
    { id: 'pin', label: session(state.pinned ? 'task.unpin' : 'task.pin'), icon: state.pinned ? 'unpin' : 'pin' },
  ]
  if (state.sidebarPin) {
    items.push(state.sidebarPin === 'unpin'
      ? { id: 'sidebar-pin', label: session('task.unpinFromSidebar'), icon: 'sidebar-off' }
      : { id: 'sidebar-pin', label: session('task.pinToSidebar'), icon: 'sidebar' })
  }
  items.push(
    { id: 'rename', label: session('task.rename'), icon: 'rename' },
    { id: 'notifications', label: messaging(state.notificationsMuted ? 'chatList.enableNotifications' : 'chatList.disableNotifications'), icon: 'bell' },
  )
  if (!state.archived) items.push({ id: 'archive', label: session('task.archiveTaskTitle'), icon: 'archive' })
  if (state.canFork) items.push({ id: 'fork', label: session('sidebar.forkSession'), icon: 'fork', fold: true })
  items.push({ id: 'copy-id', label: session('sidebar.copySessionId'), icon: 'copy', fold: true })
  if (!state.reloading) items.push({ id: 'reload', label: session('task.manualReload'), icon: 'reload', fold: true })
  if (state.hasLegacyHistory) items.push({ id: 'legacy-history', label: session('legacyDm.history'), icon: 'history', fold: true })
  items.push({ id: 'mark-all-read', label: messaging('chatList.markAllRead'), icon: 'read', fold: true, disabled: !state.hasAnyUnread })
  if (state.archived && state.canDeleteChat) {
    items.push({ id: 'delete-chat', label: messaging('chatList.delete'), icon: 'trash', fold: true, danger: true, disabled: state.canDeleteChat === 'unknown' })
  }
  return items
}

/**
 * The menu one entry shows: the table minus that entry's documented exclusions. `handled` = the actions the entry can
 * run; an action the table offers, the entry does not exclude and cannot run is a wiring bug, thrown here.
 */
export function sessionMenu(entry: SessionMenuEntry, state: SessionMenuState, handled: ReadonlySet<SessionMenuAction>): SessionMenuItem[] {
  const excluded = SESSION_MENU_EXCLUDES[entry]
  return allItems(state).filter((item) => {
    if (excluded[item.id] !== undefined) return false
    if (!handled.has(item.id)) throw new Error(`Session menu entry '${entry}' offers '${item.id}' but has no handler for it`)
    return true
  })
}
