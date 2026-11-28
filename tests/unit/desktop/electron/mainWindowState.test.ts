import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const display = { bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 33, width: 1470, height: 923 } }
let userData = ''

// electron-window-state is loaded by Node's own require (not vitest), so seed that require cache with a fake electron.
const requireFromStore = createRequire(createRequire(import.meta.url).resolve('electron-window-state'))
const electronPath = requireFromStore.resolve('electron')
requireFromStore.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => userData },
    screen: { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display },
  },
} as never

function fakeWindow() {
  return { maximize: vi.fn(), setFullScreen: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}

describe('main window state restored on launch (#1641)', () => {
  beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'main-window-state-')) })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it('opens a window that was closed in full screen as a normal window at its saved bounds', async () => {
    // The reporter's saved state: closed in full screen on the built-in display.
    writeFileSync(join(userData, 'window-state.json'), JSON.stringify({
      width: 1280, height: 840, x: 0, y: 33,
      displayBounds: display.bounds, isMaximized: false, isFullScreen: true,
    }))
    const { openMainWindowState } = await import('../../../../apps/desktop/electron/main-window-state')
    const state = openMainWindowState({ defaultWidth: 1280, defaultHeight: 900 })
    const win = fakeWindow()
    state.manage(win as never)
    expect(win.setFullScreen).not.toHaveBeenCalled()
    expect({ x: state.x, y: state.y, width: state.width, height: state.height }).toEqual({ x: 0, y: 33, width: 1280, height: 840 })
  })

  it('still restores a maximized window', async () => {
    writeFileSync(join(userData, 'window-state.json'), JSON.stringify({
      width: 1280, height: 840, x: 0, y: 33,
      displayBounds: display.bounds, isMaximized: true, isFullScreen: false,
    }))
    const { openMainWindowState } = await import('../../../../apps/desktop/electron/main-window-state')
    const win = fakeWindow()
    openMainWindowState({ defaultWidth: 1280, defaultHeight: 900 }).manage(win as never)
    expect(win.maximize).toHaveBeenCalledOnce()
  })
})
