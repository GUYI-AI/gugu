/**
 * The shape every object action table shares (session-menu.ts for a session and my agent, conversation-row-menu.ts for
 * a conversation, messageActionItems.ts for a message): one ordered list of actions with their names, icons, fold and
 * danger, and per entry only the actions it leaves out, each with its reason. An entry never adds, renames or reorders
 * an action. Renderer-free, so the chat list, the task page and the phone share it; drawn by components/MenuTableItems.tsx.
 *
 * @@@menu-order - How every object menu is ordered (owner 11-17: one design, ordered by how often each action is used).
 * There is no click data: the product records no menu usage, so each table states a one-line frequency reason per action.
 * 1. Top level: frequent actions on this one object that can be taken back, most frequent first.
 * 2. 更多 (`fold`): the rest that can be taken back: rare, acting beyond this row (mark all read), or tools (copy id,
 *    restart, fork), still most frequent first.
 * 3. Destructive (`danger`: delete, leave, remove someone, undone only by asking again): the last rows of 更多, and they
 *    always ask first (confirmDanger / confirmArchive).
 * 4. Irreversible, rare and felt by every member (dissolve a group, delete a topic): in no menu; at the bottom of that
 *    object's own settings page.
 * Archive is not destructive: it has undo and a restore in history, and it is how every task ends, so it is the last
 * top-level row. A menu of at most {@link SHORT_MENU} rows is not folded: it shows every row flat, in the same order;
 * a 更多 that would hold a single row shows it in place (ui/Menu MenuFold). The phone draws the same order flat
 * ({@link menuLayout}), so desktop and phone never differ in order.
 */

/** A label in the catalog it lives in: `session` = the task page's messages, the others = that i18next namespace. */
export type MenuLabel = { ns: 'session' | 'messaging' | 'contacts'; key: string }

export type MenuIcon =
  | 'read' | 'unread' | 'pin' | 'unpin' | 'sidebar' | 'sidebar-off' | 'rename' | 'bell' | 'archive' | 'fork' | 'copy'
  | 'reload' | 'history' | 'trash' | 'chat' | 'alias' | 'leave'

export type MenuTableItem<A extends string> = {
  id: A
  label: MenuLabel
  icon: MenuIcon
  /** Into 更多: rare, acts on more than this one row, or destructive (see @@@menu-order). */
  fold?: true
  danger?: true
  disabled?: boolean
}

/** Per entry, the actions it leaves out and why. A test pins that every reason is non-empty. */
export type MenuExcludes<E extends string, A extends string> = Record<E, Partial<Record<A, string>>>

/**
 * The menu one entry shows: the table minus that entry's documented exclusions. `handled` = the actions the entry can
 * run; an action the table offers, the entry does not exclude and cannot run is a wiring bug, thrown here (fail loud,
 * ❌ silently missing).
 */
export function entryItems<E extends string, A extends string>(
  table: string,
  entry: E,
  items: readonly MenuTableItem<A>[],
  excludes: MenuExcludes<E, A>,
  handled: ReadonlySet<A>,
): MenuTableItem<A>[] {
  const excluded = excludes[entry]
  return items.filter((item) => {
    if (excluded[item.id] !== undefined) return false
    if (!handled.has(item.id)) throw new Error(`${table} menu entry '${entry}' offers '${item.id}' but has no handler for it`)
    return true
  })
}

/** A menu this short shows every row flat: a 更多 would hide one or two rows behind a click for no room saved. */
export const SHORT_MENU = 4

/**
 * Where each row of a menu goes (@@@menu-order): top level, then 更多; destructive rows last of 更多. Every renderer —
 * the desktop menus and the phone's flat list, which draws `[...top, ...more]` — lays a menu out through this, so the
 * order cannot differ between them.
 */
export function menuLayout<T extends { fold?: true; danger?: boolean }>(items: readonly T[]): { top: T[]; more: T[] } {
  if (items.length <= SHORT_MENU) return { top: [...items.filter((item) => !item.danger), ...items.filter((item) => item.danger)], more: [] }
  const folded = items.filter((item) => item.fold || item.danger)
  return { top: items.filter((item) => !item.fold && !item.danger), more: [...folded.filter((item) => !item.danger), ...folded.filter((item) => item.danger)] }
}
