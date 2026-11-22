import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * The market list beside an App's page (app-store.css `.mk-browse[data-browsing]`) is its own scroller: it stays where it
 * starts while the page scrolls, and is exactly as tall as the part of the page's scroller below that point, so its
 * last card can be reached and scrolling either side never moves the other. The open App's card is brought to the
 * middle of the list whenever another App is opened, from the list, a link or "Similar apps".
 */
export function useBrowseList(root: RefObject<HTMLElement | null>, scroller: () => HTMLElement | null, selectedId: string | undefined, listed: number) {
  const centered = useRef<string | undefined>(undefined);
  const browsing = !!selectedId;
  useLayoutEffect(() => {
    const list = root.current?.querySelector<HTMLElement>('.mk-browse[data-browsing] > .mk-browse-list');
    const page = scroller();
    if (!list || !page) return;
    const fit = () => {
      // Where the list starts in the page, read off the grid around it: the list itself may already be stuck.
      const top = list.parentElement!.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop;
      list.style.setProperty('--mk-browse-top', `${top}px`);
      list.style.setProperty('--mk-browse-height', `${page.clientHeight - top}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(page);
    return () => observer.disconnect();
  }, [browsing]);
  useLayoutEffect(() => {
    const list = root.current?.querySelector<HTMLElement>('.mk-browse[data-browsing] > .mk-browse-list');
    const card = list?.querySelector<HTMLElement>('[aria-current]');
    if (!selectedId) centered.current = undefined;
    // Its card may only arrive with the list (an App opened from a link before the market was read).
    if (!list || !card || centered.current === selectedId) return;
    const entering = centered.current === undefined;
    centered.current = selectedId;
    // Only the list moves: scrollIntoView would also scroll the page beside it.
    const offset = card.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    list.scrollTo({ top: offset - (list.clientHeight - card.offsetHeight) / 2, behavior: entering ? 'instant' : 'smooth' });
  }, [selectedId, listed]);
}
