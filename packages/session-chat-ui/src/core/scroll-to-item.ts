import type { ScrollToItemOptions } from '../commands';

/** Center in the readable viewport; an oversized item starts at its top. */
export function itemScrollTarget(input: {
  rowTop: number;
  rowHeight: number;
  viewportHeight: number;
  align: NonNullable<ScrollToItemOptions['align']>;
  offset: number;
}): number {
  const { rowTop, rowHeight, viewportHeight, align, offset } = input;
  const target = align === 'center'
    ? rowTop - Math.max(0, (viewportHeight - rowHeight) / 2)
    : align === 'end' ? rowTop - viewportHeight + rowHeight : rowTop;
  return Math.max(0, target + offset);
}
