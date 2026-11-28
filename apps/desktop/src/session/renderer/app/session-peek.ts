import { action, makeObservable, observable } from 'mobx';
import type { CSSProperties } from 'react';
import type { SessionParams } from './recent-session-pages';
import { followBox } from '@renderer/lib/layout/follow-box';
import { clippedElementBox } from '@/lib/elementVisibility';

/**
 * A session shown beside an App (`gugu.showSession(id, { peek: true })`): its own retained session page — the same page,
 * conversation and composer as on its row's click — drawn over the box the peek holds for it, instead of a block of the
 * screen, wherever that box is (an App's full page, a chat's side panel, a session's tab). Fixed, so it is drawn where the
 * box is even while the session frame around it is hidden (the chat tabs), as the App pages' layer is.
 */
class SessionPeek {
  current: (SessionParams & { box: HTMLElement }) | null = null;

  constructor() {
    makeObservable(this, { current: observable.ref, open: action, close: action });
  }

  open(session: SessionParams & { box: HTMLElement }): void {
    this.current = session;
  }

  close(sessionId?: string): void {
    if (!sessionId || this.current?.sessionId === sessionId) this.current = null;
  }
}

export const sessionPeek = new SessionPeek();

export const PEEKED_PAGE_STYLE: CSSProperties = {
  position: 'fixed',
  // The session frame is hidden on the chat tabs; this page is shown, so it says so for itself.
  visibility: 'visible',
  pointerEvents: 'auto',
  zIndex: 40,
};

/**
 * @@@follow-the-box - the page is laid over the peek's box by measuring it, as the App pages' layer lays a page over
 * its slot, and follows it the same way (followBox). It cannot be put in the box: the box is in the shell's document
 * tree and this page's styles are in the session frame's. Placed by the box's viewport rect, then corrected by where it
 * actually landed, so a transformed ancestor cannot skew it; drawn at the opacity the box is (a peek coming or going on
 * its track).
 */
export function layOver(page: HTMLElement, box: HTMLElement): () => void {
  const place = () => {
    const { full: want, opacity } = clippedElementBox(box, { left: 0, top: 0, width: innerWidth, height: innerHeight });
    const set = (left: number, top: number) => Object.assign(page.style, {
      left: `${left}px`, top: `${top}px`, width: `${want.width}px`, height: `${want.height}px`,
      opacity: opacity < 1 ? String(opacity) : ''
    });
    set(want.left, want.top);
    const got = page.getBoundingClientRect();
    if (got.left !== want.left || got.top !== want.top) set(2 * want.left - got.left, 2 * want.top - got.top);
  };
  place();
  const stop = followBox(box, place);
  return () => {
    stop();
    // Its place back to the style it goes to (in a block, or hidden in its own box): that style sets the edges.
    Object.assign(page.style, { width: '', height: '', opacity: '' });
  };
}
