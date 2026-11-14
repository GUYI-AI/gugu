import type { ScrollMode } from '../state/scroll-mode';
import { unitItemIds, type RenderUnit } from './units';

/** Presentation ownership only: these ids must not acknowledge unread messages. */
export type ViewportProtection = {
  readonly itemIds: readonly string[];
  readonly anchor: ScrollMode;
};

/** Read only the engine's mounted range, including overscan and sticky lanes. */
export function collectViewportProtection(
  indices: readonly number[],
  at: (index: number) => RenderUnit | undefined,
  anchor: ScrollMode,
): ViewportProtection {
  const ids = new Set<string>();
  // Reconciliation can temporarily hide the reading anchor without releasing it.
  if (anchor.kind === 'anchor') ids.add(anchor.itemId);
  for (const index of indices) {
    const unit = at(index);
    if (unit) for (const id of unitItemIds(unit)) ids.add(id);
  }
  return { itemIds: [...ids], anchor: { ...anchor } };
}

export function sameViewportProtection(a: ViewportProtection | undefined, b: ViewportProtection): boolean {
  if (!a || a.itemIds.length !== b.itemIds.length || a.itemIds.some((id, i) => id !== b.itemIds[i])) return false;
  if (a.anchor.kind !== b.anchor.kind) return false;
  return a.anchor.kind === 'tail' || (b.anchor.kind === 'anchor'
    && a.anchor.itemId === b.anchor.itemId && a.anchor.edge === b.anchor.edge && a.anchor.offset === b.anchor.offset);
}
