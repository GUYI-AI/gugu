import { motion, useReducedMotion } from 'framer-motion';
import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';

/**
 * @@@drop-highlight - where a drag will land, drawn by ONE layer for every native drop target: a sidebar row (nest under it),
 * the Agents header (back to the top level), half a block (split), a pane, a composer (@). Moving between targets morphs one
 * shape on one spring (owner: liquid, Spring(380, 28)) instead of one box going out and another coming in.
 * ❌ a highlight of its own at a drop target: publish the target's box here.
 */
export const DROP_SPRING = { type: 'spring', stiffness: 380, damping: 28 } as const;

export type DropShape = { left: number; top: number; width: number; height: number; radius: string };

/** `shown` false keeps the last box so hiding only fades it; `appear` = shown after hidden: it appears in place,
 * ❌ flies in from where the last drag ended. */
type DropHighlight = DropShape & { shown: boolean; appear: boolean };
const highlight = observable.box<DropHighlight | null>(null, { deep: false });
let pendingHide = 0;

export const dropShapeOf = (element: Element, radius = getComputedStyle(element).borderRadius): DropShape => {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height, radius: radius === '0px' ? '8px' : radius };
};

/** A target took the drag: the shape goes there (from wherever it was). */
export function showDropHighlight(next: DropShape): void {
  cancelAnimationFrame(pendingHide);
  const current = highlight.get();
  if (current?.shown && (['left', 'top', 'width', 'height', 'radius'] as const).every((key) => current[key] === next[key])) return;
  runInAction(() => highlight.set({ ...next, shown: true, appear: !current?.shown }));
}

/**
 * The drag left a target. Waits one frame: leaving one row is entering the next, and that dragover moves the shape instead
 * of letting it fade out and back in.
 */
export function hideDropHighlight(): void {
  cancelAnimationFrame(pendingHide);
  pendingHide = requestAnimationFrame(() => {
    const current = highlight.get();
    if (current?.shown) runInAction(() => highlight.set({ ...current, shown: false, appear: false }));
  });
}

export const DropHighlightLayer = observer(function DropHighlightLayer() {
  const current = highlight.get();
  const reduced = useReducedMotion();
  if (!current) return null;
  const { left, top, width, height, radius, shown, appear } = current;
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none fixed z-40 border border-foreground/20 bg-foreground/10"
      style={{ left: 0, top: 0 }}
      initial={false}
      animate={{ x: left, y: top, width, height, borderRadius: radius, opacity: shown ? 1 : 0 }}
      transition={reduced || appear ? { duration: 0, opacity: DROP_SPRING } : DROP_SPRING}
      data-drop-highlight={shown ? 'shown' : 'hidden'}
      data-occludes-browser-page={shown || undefined}
    />
  );
});
