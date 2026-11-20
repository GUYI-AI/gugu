/**
 * Which window the standalone Chrome already created for a tab that is being opened for it. Chrome opens the window first; Gugu opens
 * the tab after, and the tab's page is mounted later still, so the window's id waits here between the two. It is asked for once, by
 * that tab's first mount, and is never saved with the tab: a window cannot outlive the Chrome that made it.
 */
const claims = new Map<string, string>();

export const popupClaims = {
  remember(browserId: string, popup: string): void { claims.set(browserId, popup); },
  /** The window this tab was opened for, once; `undefined` for a tab that was not opened for one, or asks again. */
  take(browserId: string): string | undefined {
    const popup = claims.get(browserId);
    claims.delete(browserId);
    return popup;
  },
  forget(browserId: string): void { claims.delete(browserId); },
};
