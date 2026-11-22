import { useLayoutEffect, useState, type CSSProperties } from 'react';

type Ref = (element: HTMLDivElement | null) => void;

/**
 * @@@last-frame — a page going off the root cut is blank before its cell is: a pane that closes leaves the store with its
 * tabs (closed, or moved to the main pane), a page the chat workspace stops showing hides at once. The cut keeps drawing
 * the cell until it is off (TrackCut `exit`, or a share of nothing); `take` draws the page's last frame over it — a copy
 * of its content as it is on screen while the render that hides it runs, inert, hidden from the accessibility tree,
 * without ids — until the track lands (`clear`). The copy is a flat sibling where the page was, pinned to the cell like
 * the page: drawn over the pages before it, under the ones after, as the page itself would be. A page drawn natively or
 * in a frame (an App page, the browser, media) would copy as a blank slab: `take` refuses a page showing one, and it goes
 * at once.
 */
const NOT_COPIED = 'iframe, webview, video, [data-extension-slot], [data-browser-page]';

export function usePaneLastFrames(anchorOf: (paneId: string) => string): {
  content: (paneId: string) => Ref;
  /** Copies the page as it is drawn now (call in the render that hides it); false: a page not copied. */
  take: (paneId: string) => boolean;
  clear: () => void;
} {
  const [frames] = useState(() => {
    const contents = new Map<string, HTMLElement>();
    // Where each copy goes: after the page, or after what was before it once the page is gone.
    const pending = new Map<string, { frame: HTMLElement; page: HTMLElement; before: Element | null; parent: Node }>();
    const drawn = new Set<HTMLElement>();
    // One callback per pane: a new one each render would detach and attach every time.
    const refs = new Map<string, Ref>();
    const copy = (paneId: string, page: HTMLElement) => {
      const frame = page.cloneNode(true) as HTMLElement;
      // A tab kept behind the one in front may hold a frame or a native page: not drawn, and a cloned <webview> would load.
      for (const native of frame.querySelectorAll(NOT_COPIED)) native.remove();
      for (const named of frame.querySelectorAll('[id], [data-testid]')) {
        named.removeAttribute('id');
        named.removeAttribute('data-testid');
      }
      frame.removeAttribute('style');
      Object.assign(frame.style, { position: 'absolute', positionAnchor: anchorOf(paneId), top: 'anchor(top)', bottom: 'anchor(bottom)', left: 'anchor(left)', right: 'anchor(right)' } as CSSProperties);
      frame.className = 'pointer-events-none overflow-hidden';
      frame.dataset.lastFrame = '';
      frame.inert = true;
      frame.setAttribute('aria-hidden', 'true');
      return frame;
    };
    return {
      take: (paneId: string) => {
        const page = contents.get(paneId);
        if (!page?.parentNode || [...page.querySelectorAll(NOT_COPIED)].some((native) => native.checkVisibility({ visibilityProperty: true }))) return false;
        pending.set(paneId, { frame: copy(paneId, page), page, before: page.previousElementSibling, parent: page.parentNode });
        return true;
      },
      flush: () => {
        for (const { frame, page, before, parent } of pending.values()) {
          if (page.isConnected) page.after(frame);
          else if (before?.isConnected) before.after(frame);
          else if (parent.isConnected) parent.insertBefore(frame, parent.firstChild);
          else continue;
          drawn.add(frame);
        }
        pending.clear();
      },
      // Also one not drawn yet: a jump lands in the cut's commit, before this view's layout effect draws it.
      clear: () => {
        pending.clear();
        for (const frame of drawn) frame.remove();
        drawn.clear();
      },
      content: (paneId: string) => refs.get(paneId) ?? refs.set(paneId, (element) => {
        if (element) return void contents.set(paneId, element);
        contents.delete(paneId);
        refs.delete(paneId);
      }).get(paneId)!,
    };
  });
  useLayoutEffect(() => frames.flush());
  return frames;
}
