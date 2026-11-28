import windowStateStore from 'electron-window-state'

/**
 * The main window's saved bounds and maximized state, restored on launch.
 *
 * Full screen is not restored (#1641). The store would call `setFullScreen(true)` on the window before it is
 * shown; on macOS with several displays and separate Spaces that transition can fail half way, leaving a
 * window with full-screen geometry outside a full-screen Space, its top under the menu bar. Launching as a
 * normal window at the saved bounds avoids the half-entered state; the user re-enters full screen when wanted.
 */
export function openMainWindowState(defaults: { defaultWidth: number; defaultHeight: number; path: string }) {
  return windowStateStore({ ...defaults, fullScreen: false })
}
