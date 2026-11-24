import { type DragEndEvent, type DragStartEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useState } from 'react';
import { setDragShield } from '@renderer/lib/drag-shield';
import type { PaneLayoutStore } from './pane-layout-store';
import { tabDragPoint, tabDropTarget } from './tab-bar/tab-motion';

/**
 * Dragging a tab of a block's strip, a task's or a chat's: within the block it is the engine's (reorder, an edge =
 * beside, the pane tree of this block only); out of the window it opens in a window of its own (`openWindow`, null = it
 * cannot). A tab never becomes a block of the screen: splits start from the inner column.
 */
export function useTabDrag({
  layout,
  openWindow,
}: {
  layout: PaneLayoutStore;
  /** How it opens in a window of its own, dropped out of this one; null: it does not. */
  openWindow: (tabId: string) => ((at: { screenX: number; screenY: number }) => void) | null;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragging, setDragging] = useState<string | null>(null);
  const onDragStart = (event: DragStartEvent) => {
    setDragShield(true);
    setDragging(String(event.active.id));
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragShield(false);
    setDragging(null);
    const tabId = String(event.active.id);
    // 拖到窗口外松手 = 单独成窗。
    const at = tabDragPoint(event);
    const open = at ? openWindow(tabId) : null;
    if (at && open) {
      const view = (at.start.target as Node | null)?.ownerDocument?.defaultView ?? window;
      if (at.x < 0 || at.y < 0 || at.x > view.innerWidth || at.y > view.innerHeight) {
        open({ screenX: at.start.screenX + at.x - at.start.clientX, screenY: at.start.screenY + at.y - at.start.clientY });
        return;
      }
    }
    const target = tabDropTarget(event);
    if (target) layout.handleDragEnd(tabId, target);
  };
  const onDragCancel = () => {
    setDragShield(false);
    setDragging(null);
  };
  return { sensors, dragging, onDragStart, onDragEnd, onDragCancel };
}
