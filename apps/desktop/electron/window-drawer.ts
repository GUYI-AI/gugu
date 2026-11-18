import { webContents, type WebContents } from 'electron'

/**
 * The renderer whose script draws this window's document.
 *
 * Usually the window itself. A blank window its opener writes into is drawn by the opener instead: that is every 咕咕
 * child window (aux-window.ts — a session, a tab or an App on its own, painted by the main window's renderer through a
 * portal, with no preload and no script of its own). Whatever such a window shows, only its opener can act on it.
 *
 * Read from Electron's own facts each time (opener, URL), ❌ 不另记一张子窗表:no state, so it is the same answer in
 * the host bundle and the session page's bundle.
 */
export function rendererDrawing(contents: WebContents): WebContents {
  if (contents.getURL() !== 'about:blank' || !contents.opener) return contents
  return webContents.fromFrame(contents.opener.top ?? contents.opener) ?? contents
}

/** `rendererDrawing` by id; null when no such page is alive. */
export function rendererDrawingId(id: number): number | null {
  const contents = webContents.fromId(id)
  return contents && !contents.isDestroyed() ? rendererDrawing(contents).id : null
}
