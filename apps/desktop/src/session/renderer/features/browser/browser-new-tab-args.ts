import type { BrowserSessionSnapshot } from '@shared/browser';
import type { BrowserOpenArgs } from './browser-tab-provider';

/**
 * What to open a sibling tab with when a page of `source` opens a window. Only the standalone browser opens a tab for a window its
 * Chrome already created (`popup` names it): that tab shows the window, which lives in the Chrome of the page's tab, so it says
 * whose profile it must be in. Any other new tab (the built-in browser's always) is opened with just its address.
 */
export function newTabArgs(event: { url: string; popup?: string }, source: BrowserSessionSnapshot | undefined): BrowserOpenArgs {
  if (!event.popup) return { initialUrl: event.url };
  return {
    initialUrl: event.url,
    popup: event.popup,
    ...(source && { windowOf: { profileId: source.profileId, partition: source.partition } }),
  };
}
