import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { RowHoverCard } from '@/components/ui/RowHoverCard';
import { RowHoverCardController } from '@/components/ui/rowHoverCardController';

const ROW = '[data-slot="list-row"]';

const text = (node: Element | null) =>
  [...(node?.childNodes ?? [])].map((child) => child.textContent?.trim() ?? '').filter(Boolean).join(' ');

/** The rail's rows are drawn by whoever owns the row (a chat, a project, the sample), so the card knows them by place. */
const railCard = new RowHoverCardController('sidebar-rail', `[data-sidebar-rail] ${ROW}`);
/** A row node's key, unique for the page's life: a remounted list's rows never inherit an old row's state (a press). */
const rowKeys = new WeakMap<Element, string>();
let nextRowKey = 0;

/**
 * On the rail a row is only its avatar, so pointing at one says what the row itself says when the list is open: its name
 * and its second line (ListRow's title and subtitle, read from the row). One card for the whole list, the product's row
 * hover card (components/ui/RowHoverCard.tsx): same wait, swap, close and motion as a group's agent rows.
 */
export function RailRowHint({ list, enabled }: { list: RefObject<HTMLElement | null>; enabled: boolean }) {
  const [rows] = useState(() => new Map<string, HTMLElement>());
  const active = useSyncExternalStore(railCard.subscribe, railCard.readActive);
  useEffect(() => {
    const element = list.current;
    if (!element || !enabled) return;
    const rowOf = (target: EventTarget | null) => {
      const row = target instanceof Element ? target.closest<HTMLElement>(ROW) : null;
      return row && element.contains(row) ? row : null;
    };
    const keyOf = (row: HTMLElement) => {
      let key = rowKeys.get(row);
      if (!key) {
        key = `rail-${nextRowKey++}`;
        rowKeys.set(row, key);
      }
      rows.set(key, row);
      return key;
    };
    // Rows are entered and left as wholes: moving between a row's own avatar and name is neither.
    const over = (event: PointerEvent) => {
      const row = rowOf(event.target);
      if (row && row !== rowOf(event.relatedTarget)) railCard.enter(keyOf(row), event.pointerType);
    };
    const out = (event: PointerEvent) => {
      const row = rowOf(event.target);
      if (row && row !== rowOf(event.relatedTarget)) railCard.leave(keyOf(row), event.relatedTarget);
    };
    const down = (event: PointerEvent) => {
      const row = rowOf(event.target);
      if (row) railCard.press(keyOf(row), event.pointerType);
    };
    element.addEventListener('pointerover', over);
    element.addEventListener('pointerout', out);
    element.addEventListener('pointerdown', down);
    return () => {
      element.removeEventListener('pointerover', over);
      element.removeEventListener('pointerout', out);
      element.removeEventListener('pointerdown', down);
      // The list opening puts the card away: open, the rows say their own names.
      if (railCard.activeKey) railCard.close(railCard.activeKey);
      rows.clear();
    };
  }, [list, enabled, rows]);
  const row = active ? rows.get(active) : undefined;
  const name = row ? text(row.querySelector('.gg-list-row-title')) : '';
  if (!active || !row || !name) return null;
  const line = text(row.querySelector('.gg-list-row-subtitle'));
  return (
    // One card per row (keyed): the next row's card opens at that row with its own entrance, as an agent row's does.
    <RowHoverCard key={active} card={railCard} rowKey={active} anchor={() => rows.get(active) ?? null} label={name} className="flex max-w-60 flex-col px-3 py-2">
      <div className="truncate font-medium">{name}</div>
      {line ? <div className="truncate text-[var(--muted-fg)]">{line}</div> : null}
    </RowHoverCard>
  );
}
