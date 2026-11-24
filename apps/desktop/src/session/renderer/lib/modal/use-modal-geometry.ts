import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';

const EDGE = 8;
const MIN_WIDTH = 400;
const MIN_HEIGHT = 180;

type Frame = { left: number; top: number; width?: number; height?: number };
type Gesture = { pointer: number; resize: boolean; x: number; y: number; start: DOMRect };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Geometry belongs to one opening of the dialog. A moved dialog still grows with its content until resized. */
export function useModalGeometry(popup: RefObject<HTMLDivElement | null>, request: number, enabled: boolean) {
  const [frame, setFrame] = useState<Frame>();
  const [cursor, setCursor] = useState<'grabbing' | 'nwse-resize'>();
  const gesture = useRef<Gesture | null>(null);

  useLayoutEffect(() => {
    gesture.current = null;
    setFrame(undefined);
    setCursor(undefined);
  }, [request, enabled]);

  useLayoutEffect(() => {
    if (!enabled) return;
    const fit = () => setFrame((current) => {
      const element = popup.current;
      if (!current || !element) return current;
      const width = current.width === undefined ? element.offsetWidth : Math.min(current.width, innerWidth - 2 * EDGE);
      const height = current.height === undefined ? element.offsetHeight : Math.min(current.height, innerHeight - 2 * EDGE);
      const left = clamp(current.left, EDGE, innerWidth - EDGE - width);
      const top = clamp(current.top, EDGE, innerHeight - EDGE - height);
      return left === current.left && top === current.top && (current.width ?? width) === width && (current.height ?? height) === height
        ? current : { left, top, width: current.width === undefined ? undefined : width, height: current.height === undefined ? undefined : height };
    });
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [enabled, popup]);

  function start(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || gesture.current || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return;
    const handle = event.target.closest('[data-modal-drag], [data-modal-resize]');
    if (!handle) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const resize = handle.hasAttribute('data-modal-resize');
    setCursor(resize ? 'nwse-resize' : 'grabbing');
    gesture.current = {
      pointer: event.pointerId, resize,
      x: event.clientX, y: event.clientY, start: event.currentTarget.getBoundingClientRect(),
    };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointer !== event.pointerId) return;
    const dx = event.clientX - active.x;
    const dy = event.clientY - active.y;
    const { start } = active;
    if (active.resize) {
      // Allow a compact, unopened card to grow from its current height on the first drag.
      const width = clamp(start.width + dx, Math.min(MIN_WIDTH, start.width), innerWidth - start.left - EDGE);
      const height = clamp(start.height + dy, Math.min(MIN_HEIGHT, start.height), innerHeight - start.top - EDGE);
      setFrame({ left: start.left, top: start.top, width, height });
    } else {
      const left = clamp(start.left + dx, EDGE, innerWidth - EDGE - start.width);
      const top = clamp(start.top + dy, EDGE, innerHeight - EDGE - start.height);
      setFrame((current) => ({ ...current, left, top }));
    }
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointer !== event.pointerId) return;
    gesture.current = null;
    setCursor(undefined);
  }

  return { frame, cursor, start, move, end };
}
