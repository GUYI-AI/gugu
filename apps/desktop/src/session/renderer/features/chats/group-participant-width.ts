import type { PaneLayoutNode } from '@renderer/features/tabs/pane-layout-tree';
import { MIN_PANE_WIDTH_PX } from '@renderer/features/tabs/pane-store';

type Split = Extract<PaneLayoutNode, { type: 'split' }>;

/**
 * The pair's shares with the participant (`at`) kept `rightWidth` px wide out of the pair's `extent` px, within the
 * least share either side may take. A cut that measures another extent shows another ratio (screen-frame), never saves one.
 */
export function participantSplitSizes(node: Split, at: number, rightWidth: number, extent: number): number[] {
  const total = node.sizes[at - 1] + node.sizes[at];
  const minShare = Math.min(0.5, MIN_PANE_WIDTH_PX / extent);
  const right = Math.min(1 - minShare, Math.max(minShare, rightWidth / extent)) * total;
  const sizes = [...node.sizes];
  sizes[at - 1] = total - right;
  sizes[at] = right;
  return sizes;
}
