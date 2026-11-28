import { useLayoutEffect, useRef, type ComponentProps, type CSSProperties, type RefObject } from 'react';

/**
 * @@@placed-surface — a surface that must not remount when the layout around it is reshaped (a pane's page, a session's
 * page, a strip) is rendered once, through a portal, into a host of its own; the host is put in the box that shows it
 * and is clipped, faded and moved with it (❌ laid over the box from outside: nothing of the box but its rectangle
 * reaches it).
 */
export function surfaceHost(className: string): HTMLDivElement {
  return Object.assign(document.createElement('div'), { className });
}

// four edges, ❌ inset: see RETAINED_SURFACE_HIDDEN_STYLE
export const FILLS_BOX: CSSProperties = { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 };

/** Puts `host` in `box` (null: nowhere), keeping what is in it as it is: its frames, its scroll, its focus. */
export function placeIn(host: HTMLElement, box: Element | null): void {
  if (host.parentNode === box) return;
  if (!box) host.remove();
  else if (host.isConnected && box.isConnected && 'moveBefore' in box) {
    (box as Element & { moveBefore(node: Node, before: Node | null): void }).moveBefore(host, null);
  }
  else box.append(host);
}

/**
 * A box that shows `host` (none: an empty box): in it while the box is there, back in `park` (still in the document) as
 * the box goes.
 */
export function SurfaceBox(
  { host, park, ...props }: ComponentProps<'div'> & { host: HTMLElement | null; park: RefObject<Element | null> }
) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!host) return undefined;
    placeIn(host, box.current);
    return () => { if (host.parentNode === box.current) placeIn(host, park.current); };
  }, [host, park]);
  return <div ref={box} {...props} />;
}
