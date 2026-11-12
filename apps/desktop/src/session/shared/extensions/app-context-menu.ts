import type { ContentMenuItem } from '../content-context-menu';

/** App labels/actions cross the bridge; the shared host keeps presentation and selection. An item with `items` opens
 * them beside it (the host's submenu); ids are unique across the whole menu, and only leaves are picked. `checked`, `danger`,
 * `title` and `person` (API 38) only say how a row looks: a wrong one is left out, the row stays. */
export function appContextMenuOf(args: Record<string, unknown>): { x: number; y: number; items: ContentMenuItem[] } {
  if (typeof args.x !== 'number' || !Number.isFinite(args.x) || typeof args.y !== 'number' || !Number.isFinite(args.y) || !Array.isArray(args.items)) {
    throw new Error('showContextMenu needs finite x/y and an items array');
  }
  const ids = new Set<string>();
  const itemsOf = (list: unknown[]): ContentMenuItem[] => list.map((raw: unknown): ContentMenuItem => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid context menu item');
    const item = raw as Record<string, unknown>;
    if (item.type === 'separator') return { type: 'separator' };
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.label !== 'string' || !item.label.trim()) throw new Error('Context menu items need unique ids and labels');
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('Context menu enabled must be a boolean');
    if (item.items !== undefined && (!Array.isArray(item.items) || !item.items.length)) throw new Error('Context menu items must be a non-empty array');
    ids.add(item.id);
    // API 38 presentation hints: one of the wrong type is dropped (the row is drawn without it), never the whole menu.
    const flag = (value: unknown) => typeof value === 'boolean' ? value : undefined;
    const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
    const hints = { checked: flag(item.checked), danger: flag(item.danger), title: text(item.title), person: text(item.person) };
    return {
      id: item.id, label: item.label,
      ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
      ...Object.fromEntries(Object.entries(hints).filter(([, value]) => value !== undefined)),
      ...(item.items === undefined ? {} : { items: itemsOf(item.items as unknown[]) }),
    };
  });
  return { x: args.x, y: args.y, items: itemsOf(args.items) };
}
