// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyNativeThemePreference, type NativeAppearanceTheme } from '../../../../apps/desktop/electron/window-material'
import { startHostThemeSystemSync, writeThemePreference } from '../../../../apps/desktop/src/session/renderer/lib/theme/host-theme'

/** A fake nativeTheme: the tone Chromium reports follows themeSource, and the OS appearance when themeSource is 'system'. */
function fakeNativeTheme(osDark: boolean) {
  return {
    osDark,
    themeSource: 'system' as NativeAppearanceTheme['themeSource'],
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? this.osDark : this.themeSource === 'dark'
    },
  }
}

describe('native appearance follows the stored theme preference on mac (#7333)', () => {
  it('copies the preference — not the resolved tone — into themeSource', () => {
    const theme = fakeNativeTheme(false)
    applyNativeThemePreference('darwin', theme, 'dark')
    expect(theme.themeSource).toBe('dark')
    // Back to following the system: themeSource is 'system' again (❌ a permanent hand-pick of the resolved tone).
    applyNativeThemePreference('darwin', theme, 'system')
    expect(theme.themeSource).toBe('system')
  })

  it('leaves Windows/Linux alone: their tray icon reads shouldUseDarkColors to match the taskbar', () => {
    const theme = fakeNativeTheme(false)
    applyNativeThemePreference('win32', theme, 'dark')
    expect(theme.themeSource).toBe('system')
  })
})

/**
 * The renderer side, with main applying the stored preference (main.ts @@@device-preferences). The fake matchMedia lags
 * behind themeSource the way Chromium does: it only sees the new appearance after `flush()`.
 */
describe('going back to the system appearance after a hand-pick (#7333)', () => {
  let main: ReturnType<typeof fakeNativeTheme>
  let mqDark = false
  const mqListeners = new Set<() => void>()
  const writes: string[] = []
  let observer: MutationObserver
  const flush = () => {
    const next = main.shouldUseDarkColors
    if (next === mqDark) return
    mqDark = next
    for (const listener of mqListeners) listener()
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(() => {
    main = fakeNativeTheme(false)
    mqDark = false
    mqListeners.clear()
    writes.length = 0
    localStorage.clear()
    delete document.documentElement.dataset.theme
    window.matchMedia = ((query: string) => ({
      media: query,
      get matches() { return mqDark },
      addEventListener: (_: string, listener: () => void) => mqListeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => mqListeners.delete(listener),
    })) as unknown as typeof window.matchMedia
    observer = new MutationObserver(() => writes.push(document.documentElement.dataset.theme ?? ''))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  })
  afterEach(() => observer.disconnect())

  it('keeps the hand-picked tone until main has let go of it, then lands on the system tone — never a third value', async () => {
    const release = startHostThemeSystemSync()
    try {
      writeThemePreference('dark')
      applyNativeThemePreference('darwin', main, 'dark')
      flush()
      await settle()
      writes.length = 0
      writeThemePreference('system') // OS is light; matchMedia still says dark until main applies and Chromium flushes
      applyNativeThemePreference('darwin', main, 'system')
      flush()
      await settle()
      expect(document.documentElement.dataset.theme).toBe('light')
      expect(writes.at(-1)).toBe('light')
      expect(writes.every((value) => value === 'dark' || value === 'light')).toBe(true)
    } finally {
      release()
    }
  })

  it('after that, a change of the system appearance still reaches data-theme', async () => {
    const release = startHostThemeSystemSync()
    try {
      writeThemePreference('system')
      main.osDark = true
      flush()
      await settle()
      expect(document.documentElement.dataset.theme).toBe('dark')
    } finally {
      release()
    }
  })
})
