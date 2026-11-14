import { app, BrowserWindow, type WebContents } from 'electron'

/**
 * @@@page-fullscreen — a page asks for fullscreen (a video's own button, in an App's page or an in-app browser tab):
 * the page fills the window, and the window fills the screen, as in a browser. Leaving puts both back.
 *
 * Electron would resize the window itself, inside the same call that tells the renderers the page's new state; on
 * macOS that resize is an animated transition, and a renderer told anything while it runs is told "still fullscreen"
 * (`IsFullscreenForTabOrPending` counts the transition). Nobody tells the window's own page again once it ends: after
 * an App's video left fullscreen, gugu's page kept the App's `<webview>` as its fullscreen element — the App covered
 * the whole window, and Esc / `exitFullscreen()` had nothing left to undo.
 *
 * So every window and every page that can go fullscreen carries `PAGE_FULLSCREEN_PREFERENCES` (Electron no longer
 * touches the window), and the window follows the page here, after the page's state has settled. The window is put
 * back only if it was the page that put it in fullscreen: one the person had made fullscreen stays so.
 */
export const PAGE_FULLSCREEN_PREFERENCES = { disableHtmlFullscreenWindowResize: true } as const

/** Windows in fullscreen because a page asked for it. */
const filledForPage = new WeakSet<BrowserWindow>()

function windowOf(contents: WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(contents) ?? (contents.hostWebContents ? BrowserWindow.fromWebContents(contents.hostWebContents) : null)
  return win && !win.isDestroyed() ? win : null
}

function followPage(contents: WebContents): void {
  // A guest and its embedder both report the change; the window moves once.
  contents.on('enter-html-full-screen', () => {
    const win = windowOf(contents)
    if (!win || filledForPage.has(win) || win.isFullScreen()) return
    filledForPage.add(win)
    win.setFullScreen(true)
  })
  contents.on('leave-html-full-screen', () => {
    const win = windowOf(contents)
    if (win && filledForPage.delete(win)) win.setFullScreen(false)
  })
}

let installed = false

/** Before the first window, like every 'web-contents-created' rule (devtools-lock). */
export function installPageFullscreen(): void {
  if (installed) return
  installed = true
  app.on('web-contents-created', (_event, contents) => followPage(contents))
}
