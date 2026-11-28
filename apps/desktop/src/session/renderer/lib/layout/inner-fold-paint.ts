/**
 * @@@inner-fold-motion — what moves inside the inner column through its fold, painted by the layout every frame
 * (workspace-layout.tsx) by direct writes on these elements only: the line on the column's right edge (`right` = how much of
 * the column is past its drawn edge) and the blocks that fade (`opacity`). ❌ An inherited variable on the column or anything
 * above it: each frame would restyle every element under it (11-26 trace: ~870 elements a frame for the column, ~3000 for the
 * page, against ~30 for the list's fold).
 */
export const INNER_FOLD_LINE = 'gg-inner-fold-line';
export const INNER_FOLD_FADES = 'gg-inner-fold-fades';

/** The fade for a drawn share of the column (1 open … 0 folded): out over the first half of a fold, in over an unfold's second. */
export function innerFoldOpacity(open: number): number {
  return Math.max(0, Math.min(1, 2 * open - 1));
}
