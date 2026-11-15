// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyNativeThemePreference,
  installSystemAppearanceRead,
  systemAppearance,
  type NativeAppearanceTheme,
} from '../../../../apps/desktop/electron/window-material'
import { SYSTEM_APPEARANCE_CHANNEL } from '../../../../apps/desktop/shared/window-material'
import {
  hydrateHostTheme,
  startHostThemeSystemSync,
  SystemAppearanceReadError,
  writeThemePreference,
} from '../../../../apps/desktop/src/session/renderer/lib/theme/host-theme'

/** A fake nativeTheme: shouldUseDarkColors follows themeSource, and the OS appearance when themeSource is 'system'. */
function fakeNativeTheme(osDark: boolean) {
  return {
    osDark,
    themeSource: 'system' as NativeAppearanceTheme['themeSource'],
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? this.osDark : this.themeSource === 'dark'
    },
  }
}

describe('main owns the native appearance (#7333, @@@device-preferences)', () => {
  it('copies the stored preference — not the resolved tone — into themeSource on mac', () => {
    const theme = fakeNativeTheme(false)
    applyNativeThemePreference('darwin', theme, 'dark')
    expect(theme.themeSource).toBe('dark')
    applyNativeThemePreference('darwin', theme, 'system')
    expect(theme.themeSource).toBe('system')
  })

  it('leaves Windows/Linux alone: their tray icon reads shouldUseDarkColors to match the taskbar', () => {
    const theme = fakeNativeTheme(false)
    applyNativeThemePreference('win32', theme, 'dark')
    expect(theme.themeSource).toBe('system')
  })

  it('refuses a preference it does not know', () => {
    expect(() => applyNativeThemePreference('darwin', fakeNativeTheme(false), 'sepia')).toThrow(/light \/ dark \/ system/)
  })

  it('answers the system appearance, whatever Gugu picked: a hand-pick on mac does not hide the OS', () => {
    const theme = fakeNativeTheme(false)
    applyNativeThemePreference('darwin', theme, 'dark')
    expect(systemAppearance('darwin', theme, () => '')).toBe('light')
    expect(systemAppearance('darwin', theme, () => 'Dark')).toBe('dark')
    applyNativeThemePreference('darwin', theme, 'system')
    theme.osDark = true
    expect(systemAppearance('darwin', theme, () => '')).toBe('dark')
    expect(systemAppearance('linux', fakeNativeTheme(true), () => '')).toBe('dark')
  })

  it('the read answers null (❌ leaves the renderer waiting) when it fails', () => {
    let handler: ((event: { sender: unknown; returnValue: unknown }, ...args: unknown[]) => void) | null = null
    installSystemAppearanceRead({
      platform: 'darwin',
      nativeTheme: { themeSource: 'dark', shouldUseDarkColors: true },
      macInterfaceStyle: () => { throw new Error('no defaults') },
      ipcMain: { on: (channel, listener) => { if (channel === SYSTEM_APPEARANCE_CHANNEL) handler = listener } },
    })
    const event = { sender: {}, returnValue: undefined as unknown }
    handler!(event)
    expect(event.returnValue).toBeNull()
  })
})

/**
 * The renderer only writes the setting and reads the system appearance. The fake matchMedia says what a pinned mac
 * themeSource says (dark), not the OS — exactly the moment a matchMedia read would paint a wrong frame.
 */
describe('the renderer settles the theme without pushing it to main (#7333)', () => {
  let osDark = false
  let mqDark = true
  const mqListeners = new Set<() => void>()
  const push = vi.fn()
  const read = vi.fn((): 'light' | 'dark' | null => (osDark ? 'dark' : 'light'))

  beforeEach(() => {
    osDark = false
    mqDark = true
    mqListeners.clear()
    push.mockClear()
    read.mockClear()
    localStorage.clear()
    delete document.documentElement.dataset.theme
    window.matchMedia = ((query: string) => ({
      media: query,
      get matches() { return mqDark },
      addEventListener: (_: string, listener: () => void) => mqListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => mqListeners.delete(listener),
    })) as unknown as typeof window.matchMedia
    // The pushes this replaced are still offered by the fake bridge: nothing may call them.
    window.electronAPI = {
      ...(window.electronAPI ?? {}),
      readSystemAppearance: read,
      syncThemePreference: push,
      syncResolvedLocale: push,
    } as unknown as typeof window.electronAPI
  })
  afterEach(() => { delete (window as { electronAPI?: unknown }).electronAPI })

  it('hand-picking and going back to the system push nothing; "system" paints the OS tone at once', () => {
    writeThemePreference('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    writeThemePreference('system')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(read).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('a hand-pick does not even ask for the system appearance', () => {
    writeThemePreference('light')
    expect(read).not.toHaveBeenCalled()
  })

  it('following the system: a change of the system appearance reaches data-theme', () => {
    const release = startHostThemeSystemSync()
    try {
      writeThemePreference('system')
      osDark = true
      for (const listener of mqListeners) listener()
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(push).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  describe('when main cannot read the system appearance', () => {
    beforeEach(() => { read.mockImplementation(() => null) })
    afterEach(() => { read.mockImplementation(() => (osDark ? 'dark' : 'light')) })

    it('picking "system" is refused loudly and leaves the stored preference and data-theme as they were', () => {
      localStorage.setItem('app-theme', 'light')
      document.documentElement.dataset.theme = 'light'
      expect(() => writeThemePreference('system')).toThrow(SystemAppearanceReadError)
      expect(localStorage.getItem('app-theme')).toBe('light')
      expect(document.documentElement.dataset.theme).toBe('light')
    })

    it('start-up restore keeps the theme the boot script already set, and says so', () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      localStorage.setItem('app-theme', 'system')
      document.documentElement.dataset.theme = 'dark'
      mqDark = false
      expect(hydrateHostTheme()).toBe('dark')
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[theme/native-appearance]'), expect.objectContaining({ preference: 'system' }))
      error.mockRestore()
    })
  })
})
