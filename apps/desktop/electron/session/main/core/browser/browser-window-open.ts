import { isSupportedBrowserNavigationUrl } from './browser-navigation';
import { isGoogleAuthUrl } from './browser-user-agent';

/**
 * What a window a page opens (window.open, target=_blank) becomes in the Gugu browser. One rule for both browsers:
 * the built-in one asks it from Electron's window-open handler, the standalone one from what Chrome reports.
 *
 * - `window`: a real window of its own, so the page keeps `window.opener` and can hear back from it (sign-in flows).
 * - `tab`: a new Gugu tab that loads the address on its own; the page that opened it has no `window.opener` to it.
 * - `deny`: nothing opens.
 */
export type WindowOpenDecision = 'window' | 'tab' | 'deny';

export function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isAllowedAuthPopupUrl(url: string): boolean {
  if (isGoogleAuthUrl(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com') return false;
    return parsed.pathname === '/login' || parsed.pathname === '/login/oauth/authorize';
  } catch {
    return false;
  }
}

/**
 * `disposition` is Electron's: 'new-window' is a popup window (window.open with sizes or bars turned off), anything else a tab.
 * `fromPopup`: the page that opened it is itself a sign-in window, which may open another sign-in window and nothing else.
 */
export function decideWindowOpen(input: { url: string; disposition: string; fromPopup?: boolean }): WindowOpenDecision {
  if (!isSupportedBrowserNavigationUrl(input.url)) return 'deny';
  if (input.disposition === 'new-window' && isAllowedAuthPopupUrl(input.url)) return 'window';
  if (input.fromPopup) return 'deny';
  return isExternalHttpUrl(input.url) ? 'tab' : 'deny';
}

/**
 * Chrome's `Page.windowOpen` lists the window features that are on, with no word for popup or tab. A tab has every bar and
 * anything less is a popup window, which is what Electron calls 'new-window' (checked against Chrome 158: plain
 * `window.open(url)` and `target=_blank` list all four bars, sized / `popup` / bars-off windows do not).
 */
export function windowOpenDisposition(features: readonly string[] | undefined): 'new-window' | 'foreground-tab' {
  if (!features) return 'foreground-tab';
  return ['menubar', 'toolbar', 'status', 'scrollbars'].every(bar => features.includes(bar)) ? 'foreground-tab' : 'new-window';
}
