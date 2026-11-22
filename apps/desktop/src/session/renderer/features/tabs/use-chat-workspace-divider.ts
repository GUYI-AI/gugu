import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { setDragShield } from '@renderer/lib/drag-shield';
import { chatDividerAt, type ChatToolSide } from './chat-tool-geometry';
import type { PaneLayoutStore } from './pane-layout-store';

/** The pointer can cross the divider's minimum while its two rendered panes stay at that boundary. */
export function useChatWorkspaceDivider(layout: PaneLayoutStore, splitId: string | undefined) {
  const handleRef = useRef<HTMLDivElement>(null);
  const held = useRef<(() => void) | null>(null);
  const [feedback, setFeedback] = useState<{ preview: ChatToolSide; ready: boolean }>();

  useLayoutEffect(() => {
    const handle = handleRef.current;
    const view = handle?.ownerDocument.defaultView;
    if (!splitId || !handle || !view) return;
    // This divider's left-button press is its own gesture: cancelled at document capture so no
    // text selection or mouse-down default starts under it; its keyboard resize stays the cut's.
    const claimPointer = (event: PointerEvent) => {
      const target = event.target;
      if (event.button === 0 && target && 'nodeType' in target && handle.contains(target as Node)) event.preventDefault();
    };
    view.addEventListener('pointerdown', claimPointer, true);
    return () => {
      view.removeEventListener('pointerdown', claimPointer, true);
      held.current?.();
    };
  }, [layout, splitId]);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = event.currentTarget;
    const frame = handle.parentElement;
    const view = handle.ownerDocument.defaultView;
    const [left, right] = layout.groups;
    if (!splitId || held.current || event.button !== 0 || !frame || !view || !left || !right) return;

    const pointer = event.pointerId;
    const startX = handle.getBoundingClientRect().left;
    const grab = event.clientX - startX;
    const before = layout.paneSizes;
    let canceled = false;
    let moved = false;

    const geometry = (x: number) => {
      const rect = frame.getBoundingClientRect();
      const leftMin = layout.paneMinWidth(left.paneId);
      const rightMin = layout.paneMinWidth(right.paneId);
      if (rect.width < leftMin + rightMin + 1) return;
      return chatDividerAt(x - rect.left - grab, rect.width, leftMin, rightMin);
    };

    const resize = (x: number) => {
      const target = geometry(x);
      if (!target) return;
      layout.setSplitSizes(splitId, target.sizes);
      setFeedback(target.preview ? { preview: target.preview, ready: !!target.collapse } : undefined);
      return target.collapse;
    };

    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      if (canceled) return;
      moved = true;
      resize(next.clientX);
    };

    const cleanup = () => {
      view.removeEventListener('pointermove', move, true);
      view.removeEventListener('pointerup', up, true);
      view.removeEventListener('pointercancel', cancelPointer, true);
      view.removeEventListener('blur', cancel);
      view.removeEventListener('keydown', keyDown, true);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      setDragShield(false);
      setFeedback(undefined);
      held.current = null;
    };

    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      const collapse = !canceled && moved ? resize(next.clientX) : undefined;
      cleanup();
      if (collapse) layout.collapseChatToolSide(collapse);
    };

    const reset = () => {
      if (moved) layout.setSplitSizes(splitId, before);
      setFeedback(undefined);
      canceled = true;
    };

    const cancel = () => {
      if (!canceled) reset();
      cleanup();
    };

    const cancelPointer = (next: PointerEvent) => { if (next.pointerId === pointer) cancel(); };
    const keyDown = (next: KeyboardEvent) => {
      if (next.key !== 'Escape' || canceled) return;
      next.preventDefault();
      reset();
      setDragShield(false);
    };

    held.current = cancel;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(pointer);
    setDragShield(true);
    view.addEventListener('pointermove', move, true);
    view.addEventListener('pointerup', up, true);
    view.addEventListener('pointercancel', cancelPointer, true);
    view.addEventListener('blur', cancel);
    view.addEventListener('keydown', keyDown, true);
  };

  return { start, handleRef, preview: feedback?.preview, ready: feedback?.ready };
}
