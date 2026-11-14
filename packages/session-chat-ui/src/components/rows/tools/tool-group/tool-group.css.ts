import { style } from '@vanilla-extract/css';

// The engine height is a plain inline `height` on the root, never a custom property: a custom property inherits, so
// changing it restyles the whole subtree — per streamed chunk, O(content) (see user-message.css.ts).

/**
 * Root container clipped to the measured composite height.
 * overflow:hidden ensures transient measure-vs-render desync degrades to
 * clipping rather than overflowing into the next row.
 */
export const toolGroupRoot = style({
  overflow: 'hidden',
});

/**
 * Children stack in one gapped column. The gap value itself is a measured input
 * (`ToolGroupVars.childGap`) so it stays inline; only the column rule lives here.
 *
 * @@@no flex-shrink guard — the obvious worry with switching this stack from
 * block to flex is that a clipped ancestor would squash the rows instead of
 * cutting them off. Measured, it cannot: neither branch ever gives this column
 * a definite height. Expanded, it sits in an auto-height block; collapsed, its
 * parent is PreviewWindow's `max-height` scroller, which is also auto. Adding
 * `flex-shrink: 0` here reads as insurance but is inert — dropping it, and even
 * combining that with `height: 100%`, leaves all 39 contracts green.
 */
export const toolGroupChildStack = style({
  display: 'flex',
  flexDirection: 'column',
});
