/**
 * One action table for a session — and for my agent, whose name and task are that session (task-name.ts). Every menu
 * that shows it — its tab, its sidebar row, its contacts row, the phone's session menu — draws from this table:
 * the same actions, the same names, the same order, the same fold. An entry only says which actions do not apply
 * where it is, and why ({@link SESSION_MENU_EXCLUDES}); it never adds, renames or reorders one.
 *
 * Kept free of renderer imports (like conversation-row-menu.ts) so the chat list, the task page and the phone share it.
 */

import { entryItems, type MenuExcludes, type MenuLabel, type MenuTableItem } from './menu-table'

export type SessionMenuAction =
  | 'open-chat'
  | 'mark-read'
  | 'mark-unread'
  | 'pin'
  | 'sidebar-pin'
  | 'rename'
  | 'notifications'
  | 'archive'
  | 'fork'
  | 'copy-id'
  | 'reload'
  | 'legacy-history'
  | 'leave-split'
  | 'open-window'

export type SessionMenuEntry = 'tab' | 'sidebar-row' | 'one-list-task' | 'phone' | 'contacts'

export type SessionMenuLabel = MenuLabel
export type SessionMenuItem = MenuTableItem<SessionMenuAction>

export type SessionMenuState = {
  /** 置顶 acts on the row this agent shows as in the left list (see {@link SessionMenuPin}). */
  pinned: boolean
  /** 固定到左侧栏: null = not offered (a child session never is a row of the left list). */
  sidebarPin: 'pin' | 'unpin' | null
  /** The task is already archived: no archive. */
  archived?: boolean
  hasUnread?: boolean
  notificationsMuted?: boolean
  /** Forking needs the harness to support it on this runtime. */
  canFork?: boolean
  /** Restarting is unavailable while one is in flight. */
  reloading?: boolean
  /** The legacy DM history exists for this agent. */
  hasLegacyHistory?: boolean
  /** The task is a block of a split screen: 取消并排 takes it off the screen. */
  inSplit?: boolean
  /** The whole task can open in a window of its own (screen-layout openInWindow): the one entry for it, on its row. */
  canOpenWindow?: boolean
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
export const SESSION_MENU_EXCLUDES: MenuExcludes<SessionMenuEntry, SessionMenuAction> = {
  tab: {
    'open-chat': 'The tab is the open chat.',
    'mark-read': 'The tab is open: what it shows is being read.',
    'mark-unread': 'The tab is open: what it shows is being read.',
    notifications: 'Notifications belong to the conversation; its settings are one click away in the chat page.',
  },
  'sidebar-row': {
    'open-chat': 'Clicking the row opens it.',
    'mark-read': 'A project task row has no conversation of its own to mark read.',
    'mark-unread': 'A project task row has no conversation of its own to mark unread.',
    notifications: 'A project task row has no conversation of its own to mute.',
    reload: 'Restarting asks through the session page confirmation, which lives with the open session.',
    'legacy-history': 'The legacy history dialog lives with the open session page.',
  },
  'one-list-task': {
    'open-chat': 'Clicking the row opens it.',
    'mark-read': 'A task without an identity has no conversation of its own to mark read.',
    'mark-unread': 'A task without an identity has no conversation of its own to mark unread.',
    pin: 'These rows follow every conversation, newest first (oneListTail): a pin would order nothing.',
    'sidebar-pin': 'Pin to sidebar keeps an agent\'s row; a task without an identity has no agent.',
    notifications: 'A task without an identity has no conversation of its own to mute.',
    fork: 'Forking is offered on the open task\'s tab, where its engine and runtime are read.',
    reload: 'Restarting asks through the session page confirmation, which lives with the open session.',
    'legacy-history': 'The legacy history dialog lives with the open session page.',
  },
  phone: {
    'open-chat': 'The phone session menu is on the open session page or on its row, which opens it.',
    'mark-read': 'The phone session list has no conversation unread state.',
    'mark-unread': 'The phone session list has no conversation unread state.',
    notifications: 'The phone session list has no conversation notification setting.',
    'sidebar-pin': 'The left list is desktop only.',
    fork: 'The phone has no fork call to the task host.',
    'copy-id': 'Session ids are a desktop tool.',
    reload: 'The phone has no restart call to the task host.',
    'legacy-history': 'The legacy history dialog is desktop only.',
  },
  contacts: {
    'sidebar-pin': 'Pin to sidebar is offered on the agent\'s own rows in the left list.',
    fork: 'The contact may stand for a task on another machine; forking needs the task on this one.',
    'copy-id': 'The contact may stand for a task on another machine; its session id is not known here without opening it.',
    reload: 'Restarting needs the task mounted on this machine.',
    'legacy-history': 'The legacy history dialog lives with the open session page.',
  },
}

const session = (key: string): MenuLabel => ({ ns: 'session', key })
const messaging = (key: string): MenuLabel => ({ ns: 'messaging', key })
const contacts = (key: string): MenuLabel => ({ ns: 'contacts', key })

/**
 * The whole table, in order, before any entry leaves anything out. Ordered by menu-table.ts @@@menu-order; there is no
 * click data, so each row says why it sits where it does.
 */
function allItems(state: SessionMenuState): SessionMenuItem[] {
  const items: SessionMenuItem[] = [
    // Message: what a contacts row is opened for (excluded wherever clicking the row already opens it).
    { id: 'open-chat', label: contacts('contextMenu.startChat'), icon: 'chat' },
    // Read state, one row: mark read while something is unread, mark unread otherwise. Several times a day, triaging.
    state.hasUnread
      ? { id: 'mark-read', label: messaging('chatList.markRead'), icon: 'read' }
      : { id: 'mark-unread', label: contacts('contextMenu.markUnread'), icon: 'unread' },
    // Pin: a few times a week, keeping the tasks in hand at the top.
    { id: 'pin', label: session(state.pinned ? 'task.unpin' : 'task.pin'), icon: state.pinned ? 'unpin' : 'pin' },
    // Rename: once for many tasks, soon after they start.
    { id: 'rename', label: session('task.rename'), icon: 'rename' },
  ]
  // Leave the split: only while the task is one of the blocks side by side, the reason to open this menu then.
  if (state.inSplit) items.unshift({ id: 'leave-split', label: session('screen.leaveSplit'), icon: 'leave' })
  // Archive: how every finished task ends, so as frequent as tasks are started. Undone from its toast or history, so
  // not destructive: the last top-level row.
  if (!state.archived) items.push({ id: 'archive', label: session('task.archiveTaskTitle'), icon: 'archive' })
  // 更多 — pin to the sidebar: set once for an agent that lives in a group or project.
  if (state.sidebarPin) {
    items.push(state.sidebarPin === 'unpin'
      ? { id: 'sidebar-pin', label: session('task.unpinFromSidebar'), icon: 'sidebar-off', fold: true }
      : { id: 'sidebar-pin', label: session('task.pinToSidebar'), icon: 'sidebar', fold: true })
  }
  // 更多 — notifications: set once per agent, if ever; one's own agents are rarely muted.
  items.push({ id: 'notifications', label: messaging(state.notificationsMuted ? 'chatList.enableNotifications' : 'chatList.disableNotifications'), icon: 'bell', fold: true })
  // 更多 — fork: a few times a week at most, to try another direction.
  if (state.canFork) items.push({ id: 'fork', label: session('sidebar.forkSession'), icon: 'fork', fold: true })
  // 更多 — restart: only when a task is stuck.
  if (!state.reloading) items.push({ id: 'reload', label: session('task.manualReload'), icon: 'reload', fold: true })
  // 更多 — copy the session id: a tool for reporting a problem.
  items.push({ id: 'copy-id', label: session('sidebar.copySessionId'), icon: 'copy', fold: true })
  // 更多 — the legacy history: read once, after the move to tasks.
  // A window of its own: now and then, to keep an eye on a task beside the main window. The task's only such entry.
  if (state.canOpenWindow) items.push({ id: 'open-window', label: session('screen.openInWindow'), icon: 'window', fold: true })
  if (state.hasLegacyHistory) items.push({ id: 'legacy-history', label: session('legacyDm.history'), icon: 'history', fold: true })
  return items
}

/** The menu one entry shows: the table minus that entry's documented exclusions (menu-table.ts `entryItems`). */
export function sessionMenu(entry: SessionMenuEntry, state: SessionMenuState, handled: ReadonlySet<SessionMenuAction>): SessionMenuItem[] {
  return entryItems('Session', entry, allItems(state), SESSION_MENU_EXCLUDES, handled)
}
