import type { Hotkey } from '@tanstack/hotkeys';
import { menuLayout } from './menu-table';

export const CONTENT_CONTEXT_MENU_OPEN = 'content-context-menu:open';
export const CONTENT_CONTEXT_MENU_ACTION = 'content-context-menu:action';

export type ContentMenuItem =
  | { type: 'separator' }
  | {
    type?: 'item'; id: string; label: string; enabled?: boolean; hotkey?: Hotkey; icon?: 'comment'; items?: ContentMenuItem[];
    /** One of a choice; the chosen one is marked. */
    checked?: boolean;
    /** Removes or undoes something; drawn in the danger color. */
    danger?: boolean;
    /** Why the row is as it is (a disabled one's reason). */
    title?: string;
    /** The row is this member (user or agent id): drawn with the member's avatar and shown name, `label` until it is known. */
    person?: string;
    /** The row is this program of the computer (an id of `files.openInApps`): drawn with the program's icon. */
    program?: string;
    /** Rare: laid under 更多 by the host's one menu rule (`contentMenuLayout`). */
    fold?: true;
    /** Its name when its submenu holds only it and it is shown in the submenu's place. */
    alone?: string;
  };

/** An item with `items` opens them beside it; only leaves are actions. */
export type ContentMenuEntry =
  ({ type: 'separator' } | (Omit<Exclude<ContentMenuItem, { type: 'separator' }>, 'items'> & { items?: ContentMenuEntry[] }))
  & { click?: () => void | Promise<void> };

/** The leaf picked by id, at any depth. */
export function findContentMenuItem<T extends ContentMenuItem | ContentMenuEntry>(items: readonly T[], id: string): Exclude<T, { type: 'separator' }> | undefined {
  for (const item of items) {
    if (item.type === 'separator') continue;
    const found = item.items ? findContentMenuItem(item.items as T[], id) : item.id === id ? item : undefined;
    if (found) return found as Exclude<T, { type: 'separator' }>;
  }
  return undefined;
}

export interface ContentContextMenu {
  requestId: string;
  x: number;
  y: number;
  items: ContentMenuItem[];
}

export interface ContentMenuAction {
  requestId: string;
  /** Omitted when the menu is dismissed. */
  actionId?: string;
}

type Row = Exclude<ContentMenuItem, { type: 'separator' }>;
const isRow = (item: ContentMenuItem): item is Row => item.type !== 'separator';

/** Separators only between rows: none first, last or twice. */
function tidy(items: readonly ContentMenuItem[]): ContentMenuItem[] {
  return items.filter((item, i) => isRow(item)
    || (items.slice(0, i).some(isRow) && items[i + 1]?.type !== 'separator' && items.slice(i + 1).some(isRow)));
}

/** A submenu holding one row shows that row in its place (named `alone` when it says so): one row behind a step saves nothing. */
function inPlace(item: ContentMenuItem): ContentMenuItem {
  if (!isRow(item) || !item.items) return item;
  const items = tidy(item.items.map(inPlace));
  const rows = items.filter(isRow);
  if (rows.length === 1) return { ...rows[0], label: rows[0].alone ?? rows[0].label };
  return { ...item, items };
}

/**
 * @@@content-menu-layout - How the host lays out a content menu, an App's included (API 62): by the one rule every object
 * menu follows (menu-table.ts @@@menu-order, `menuLayout`). Rows that say `fold` go under 更多 (`more`), the destructive
 * last; a menu of at most SHORT_MENU rows stays flat, destructive last. A menu with no `fold` row is drawn as given.
 * Renderers draw `more` as a MenuFold (in place when it holds one row; flat on a phone, as every host menu).
 */
export function contentMenuLayout(items: readonly ContentMenuItem[]): { top: ContentMenuItem[]; more: Row[] } {
  const given = tidy(items.map(inPlace));
  if (!given.some((item) => isRow(item) && item.fold)) return { top: given, more: [] };
  const { top, more } = menuLayout(given.filter(isRow));
  const kept = new Set<ContentMenuItem>(top.filter((row) => !row.danger));
  return { top: tidy([...given.filter((item) => !isRow(item) || kept.has(item)), ...top.filter((row) => row.danger)]), more };
}
