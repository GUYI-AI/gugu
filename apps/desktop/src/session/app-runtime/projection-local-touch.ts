import type { ProjectionInput } from '@shared/extensions/projection-protocol';

/** Phone Computer Use: local zoom/pan must never begin a remote drag or click. */
export function installLocalTouchViewing(surface: HTMLElement, options: {
  point(event: PointerEvent): { x: number; y: number } | null;
  send(input: ProjectionInput): void; focus(): void; signal: AbortSignal;
}) {
  const pointers = new Map<number, { x: number; y: number }>();
  let cancelled = false;
  const clear = () => { pointers.clear(); cancelled = false; };
  surface.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !options.point(event)) return;
    event.preventDefault();
    if (pointers.size) cancelled = true;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }, { signal: options.signal });
  window.addEventListener('pointermove', event => {
    const start = pointers.get(event.pointerId);
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancelled = true;
  }, { capture: true, signal: options.signal });
  window.addEventListener('pointerup', event => {
    const start = pointers.get(event.pointerId);
    if (!start) return;
    const tap = !cancelled && pointers.size === 1 && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8;
    pointers.delete(event.pointerId);
    if (!pointers.size) cancelled = false;
    const point = tap ? options.point(event) : null;
    if (!point) return;
    options.focus();
    options.send({ kind: 'pointer', action: 'down', button: 'left', ...point });
    options.send({ kind: 'pointer', action: 'up', button: 'left', ...point });
  }, { capture: true, signal: options.signal });
  window.addEventListener('pointercancel', event => {
    if (!pointers.delete(event.pointerId)) return;
    cancelled = pointers.size > 0;
  }, { capture: true, signal: options.signal });
  window.addEventListener('blur', clear, { signal: options.signal });
}
