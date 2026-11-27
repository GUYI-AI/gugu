/**
 * @@@inner-fold-motion — what moves inside the inner column through its fold: animations on these elements only, riding the
 * column's move on its track (workspace-layout.tsx, PanelTrack.ride): the line on the column's right edge (`right` = how much
 * of the column is past its drawn edge) and the blocks that fade (`opacity`). ❌ An inherited variable on the column or
 * anything above it: each frame would restyle every element under it (11-26 trace: ~870 elements a frame for the column,
 * ~3000 for the page, against ~30 for the list's fold).
 */
export const INNER_FOLD_LINE = 'gg-inner-fold-line';
export const INNER_FOLD_FADES = 'gg-inner-fold-fades';

/** The fade for a drawn share of the column (1 open … 0 folded): out over the first half of a fold, in over an unfold's second. */
export function innerFoldOpacity(open: number): number {
  return Math.max(0, Math.min(1, 2 * open - 1));
}

/** Keyframes for a value of the column's drawn share through a move from `from` to `to` px of `content`: its ends, and the half-way point if the move crosses it (where the fades start or stop). */
export function innerFoldFrames(from: number, to: number, content: number, property: string, at: (open: number) => number): Keyframe[] {
  const half = (content / 2 - from) / (to - from);
  return [0, ...(half > 0 && half < 1 ? [half] : []), 1].map((offset) => ({ offset, [property]: String(at((from + (to - from) * offset) / content)) }));
}
