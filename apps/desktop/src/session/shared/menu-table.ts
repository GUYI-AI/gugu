/**
 * The shape every object action table shares (session-menu.ts for a session and my agent, conversation-menu.ts for a
 * conversation): one ordered list of actions with their names, icons, fold and danger, and per entry only the actions it
 * leaves out, each with its reason. An entry never adds, renames or reorders an action. Renderer-free, so the chat list,
 * the task page and the phone share it; drawn by components/MenuTableItems.tsx.
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
  /** Into 更多: low-frequency, or acts on more than this one row. */
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
