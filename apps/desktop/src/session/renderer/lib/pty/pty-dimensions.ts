/**
 * Standalone terminal dimension measurement utility.
 *
 * Extracted from FitAddon.proposeDimensions() but decoupled from any specific
 * terminal instance — accepts a container element and cell metrics directly.
 * This lets callers measure any DOM element (e.g. the PaneDimensionProvider's
 * container) without first mounting a terminal inside it.
 */

const MINIMUM_COLS = 2;
const MINIMUM_ROWS = 1;

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

/**
 * Per-side inset applied before dividing by cell dimensions.
 * Each field defaults to 0. When all four sides share the same value use the
 * `paddingPx` shorthand on `computeGridDimensions` instead.
 */
export interface GridPadding {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

/**
 * Pure grid-dimension calculation: convert pixel dimensions → terminal cols/rows.
 *
 * Use `padding` for asymmetric insets (e.g. a context bar only on the bottom).
 * Use `paddingPx` as a uniform shorthand: it adds to all four sides of `padding`
 * before the calculation. Both default to 0 so existing callers are unchanged.
 *
 */
export function computeGridDimensions({
  widthPx,
  heightPx,
  cellWidth,
  cellHeight,
  paddingPx = 0,
  padding,
  scrollbarWidth = 0,
}: {
  widthPx: number;
  heightPx: number;
  cellWidth: number;
  cellHeight: number;
  /** Uniform inset added to all four sides before the per-side `padding`. */
  paddingPx?: number;
  /** Per-side insets (added on top of `paddingPx`). */
  padding?: GridPadding;
  scrollbarWidth?: number;
}): TerminalDimensions | null {
  if (cellWidth === 0 || cellHeight === 0) return null;
  const top = paddingPx + (padding?.top ?? 0);
  const right = paddingPx + (padding?.right ?? 0);
  const bottom = paddingPx + (padding?.bottom ?? 0);
  const left = paddingPx + (padding?.left ?? 0);
  const availW = widthPx - scrollbarWidth - left - right;
  const availH = heightPx - top - bottom;
  if (Number.isNaN(availW) || Number.isNaN(availH) || availH <= 0) return null;
  return {
    cols: Math.max(MINIMUM_COLS, Math.floor(availW / cellWidth)),
    rows: Math.max(MINIMUM_ROWS, Math.floor(availH / cellHeight)),
  };
}

