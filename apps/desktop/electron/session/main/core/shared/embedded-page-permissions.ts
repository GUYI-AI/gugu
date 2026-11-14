import type { Session } from 'electron';

/**
 * Web permissions a page embedded in gugu may use without asking — a page in
 * an in-app browser tab and an App's page alike. Everything else (camera,
 * microphone, geolocation, notifications, USB/HID/serial, …) is denied
 * (Electron security checklist #5).
 *
 * Each permission here acts only on the page's own frame: writing what it was
 * asked to copy, or filling the window with one of its elements. None reaches
 * the device or another origin's data, so the answer does not depend on what
 * the session holds — a browser profile's logged-in sites, or an App's sandbox.
 * Shared so the two kinds of embedded page cannot drift apart again.
 */
const EMBEDDED_PAGE_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
]);

export function applyEmbeddedPagePermissions(
  ses: Session,
  onDenied: (permission: string) => void
): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const granted = EMBEDDED_PAGE_PERMISSIONS.has(permission);
    if (!granted) onDenied(permission);
    callback(granted);
  });
  ses.setPermissionCheckHandler((_webContents, permission) =>
    EMBEDDED_PAGE_PERMISSIONS.has(permission)
  );
}
