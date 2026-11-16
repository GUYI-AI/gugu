import type { Measured, MeasureCtx } from '@session-chat/core/define';
import type { BlockLeafLayout } from '@session-chat/core/layout/layout-types';
import type { Block } from '@session-chat/core/markdown/document';
import type { Margin } from '@session-chat/core/spacing';
import type { JSX } from 'solid-js';

export type { Margin };

export type BlockDef<B extends Block, L extends BlockLeafLayout> = {
  kind: B['kind'];
  /**
   * Required vertical margins for this block kind.
   *
   * Receives the block so prose can branch on `block.variant`. At each seam
   * `layoutBlockStack` collapses adjacent margins to max(prev.bottom, cur.top).
   * Hidden/collapsed blocks are skipped. No fallback — every def must declare margins.
   */
  margin(block: B): Margin;
  measure(block: B, ctx: MeasureCtx): Measured<L>;
  /**
   * What `Render` paints depends on the block's content only, not on the width it was measured at: a re-measure
   * of the same source block (a width change) keeps its DOM, and `Render` reads the current measure from its props.
   * Unset, a re-measured block remounts.
   */
  domFromContentOnly?: boolean;
  Render(props: { node: Measured<L> }): JSX.Element;
};

export function defineBlock<B extends Block, L extends BlockLeafLayout>(
  d: BlockDef<B, L>
): BlockDef<B, L> {
  return d;
}
