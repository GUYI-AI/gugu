import { LIBRARY_TABS, type LibraryTab } from '../library-tabs';

/**
 * API 52: `contributes.hostLinks`, pages of gugu itself an App points at — for a tool-only App, the place the data its
 * tools manage is shown (提示词管理 → 资源库 → 提示词). The host draws each as one entry on the App's host page, titled with
 * the page's own name, and opens the page with the host's own navigation: the App writes no text and runs nothing, so an
 * entry can never pretend to be something else.
 *
 * A closed set of `<family>:<page>`: `library:` is the first family (its pages are the Library's tabs, one list); pages
 * elsewhere in gugu join later as families of their own, which is why the prefix is there.
 */
export const HOST_LINKS_API_VERSION = 52;
export const HOST_LINK_MAX = 4;

export type HostLink = `library:${LibraryTab}`;
export const HOST_LINKS = LIBRARY_TABS.map((tab) => `library:${tab}` as const) as unknown as readonly [HostLink, ...HostLink[]];

/** Where a host link opens: the view and its params, as `navigation.navigate` takes them. */
export function hostLinkTarget(link: HostLink): { view: 'library'; params: { tab: LibraryTab } } {
  return { view: 'library', params: { tab: link.slice('library:'.length) as LibraryTab } };
}
