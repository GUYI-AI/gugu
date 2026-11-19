// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adoptStoredPreferences,
  DEVICE_PREFERENCES_FACTORY,
  firstDevicePreferences,
  readStoredPreferences,
  removeStoredPreferences,
  storedPreferenceStrings,
  type DevicePreferences,
} from '../../../../apps/desktop/shared/device-preferences'

const OLD_KEYS = {
  'app-theme': 'dark',
  'gugu.locale.preference.v1': 'en-US',
  'gugu.sidebar-tint': 'true',
  'gugu.tray-badge-enabled': 'false',
  'gugu.notification-settings': JSON.stringify({ messages: false, requests: true }),
  'gugu.voiceNotes.meetingReminder': 'off',
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  delete (window as { guguFirstFrame?: unknown }).guguFirstFrame
  delete document.documentElement.dataset.theme
  delete document.documentElement.dataset.themePreference
  document.documentElement.removeAttribute('data-sidebar-tint')
  vi.unstubAllGlobals()
})

describe('the one-time move of the old keys (main adopts, preload deletes what was settled)', () => {
  it('adopts every old value main has none of, and settles every key', () => {
    for (const [key, value] of Object.entries(OLD_KEYS)) localStorage.setItem(key, value)
    const adoption = adoptStoredPreferences(storedPreferenceStrings(localStorage), () => false)
    expect(adoption.patch).toEqual({
      theme: 'dark', locale: 'en-US', sidebarTint: true, trayBadge: false, chatMessages: false, chatSound: true, meetingReminder: false,
    } satisfies DevicePreferences)
    expect(adoption.unreadable).toEqual([])
    removeStoredPreferences(localStorage, adoption.settled)
    expect(Object.keys(OLD_KEYS).filter((key) => localStorage.getItem(key) !== null)).toEqual([])
  })

  it("main's own value wins over an old key; the key is settled all the same", () => {
    localStorage.setItem('app-theme', 'dark')
    localStorage.setItem('gugu.notification-settings', JSON.stringify({ chatMessages: false, sound: false }))
    const adoption = adoptStoredPreferences(storedPreferenceStrings(localStorage), (field) => field === 'theme' || field === 'chatSound')
    expect(adoption.patch).toEqual({ chatMessages: false })
    expect(adoption.settled.sort()).toEqual(['chatNotifications', 'theme'])
  })

  it('an unreadable old value is named, not adopted, and settled (it would be refused again on every start)', () => {
    localStorage.setItem('app-theme', 'sepia')
    localStorage.setItem('gugu.notification-settings', '{not json')
    localStorage.setItem('gugu.locale.preference.v1', 'zh-CN')
    const adoption = adoptStoredPreferences(storedPreferenceStrings(localStorage), () => false)
    expect(adoption.patch).toEqual({ locale: 'zh-CN' })
    expect(adoption.unreadable.sort()).toEqual(['chatNotifications', 'theme'])
    expect(adoption.settled.sort()).toEqual(['chatNotifications', 'locale', 'theme'])
  })

  it('a start after the move sends nothing and settles nothing', () => {
    expect(storedPreferenceStrings(localStorage)).toEqual({})
    expect(adoptStoredPreferences({}, () => false)).toEqual({ patch: {}, settled: [], unreadable: [] })
  })
})

describe("the shell's first value", () => {
  it('web / phone read localStorage, the retired plain-white as light', () => {
    localStorage.setItem('app-theme', 'plain-white')
    localStorage.setItem('gugu.sidebar-tint', 'true')
    expect(readStoredPreferences(localStorage)).toEqual({ ...DEVICE_PREFERENCES_FACTORY, theme: 'light', sidebarTint: true })
    expect(firstDevicePreferences(window)).toEqual(readStoredPreferences(localStorage))
  })

  it("desktop reads main's first-frame answer only, ❌ the old keys even where they are still there", () => {
    localStorage.setItem('app-theme', 'dark')
    const fromMain = { ...DEVICE_PREFERENCES_FACTORY, theme: 'system' as const }
    expect(firstDevicePreferences({ guguFirstFrame: { devicePreferences: fromMain }, localStorage })).toBe(fromMain)
    // Main had none to give (said there): the factory values, not the old keys.
    expect(firstDevicePreferences({ guguFirstFrame: { devicePreferences: null }, localStorage })).toBe(DEVICE_PREFERENCES_FACTORY)
  })
})

describe('the boot script draws the first frame from the same store', () => {
  const bootScript = readFileSync('apps/desktop/index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]!
  const runBoot = () => new Function('window', 'document', 'localStorage', bootScript)(window, document, localStorage)
  const root = document.documentElement

  it("desktop: theme and sidebar tint from main's answer, the old keys ignored", () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    localStorage.setItem('app-theme', 'light')
    ;(window as { guguFirstFrame?: unknown }).guguFirstFrame = { viewState: null, devicePreferences: { ...DEVICE_PREFERENCES_FACTORY, theme: 'system', sidebarTint: true } }
    runBoot()
    expect([root.dataset.theme, root.dataset.themePreference, root.getAttribute('data-sidebar-tint')]).toEqual(['dark', 'system', 'on'])
  })

  it('desktop without an answer from main: the factory light, no tint', () => {
    localStorage.setItem('app-theme', 'dark')
    localStorage.setItem('gugu.sidebar-tint', 'true')
    ;(window as { guguFirstFrame?: unknown }).guguFirstFrame = { viewState: null, devicePreferences: null }
    runBoot()
    expect([root.dataset.theme, root.getAttribute('data-sidebar-tint')]).toEqual(['light', null])
  })

  it('web: from localStorage', () => {
    localStorage.setItem('app-theme', 'dark')
    localStorage.setItem('gugu.sidebar-tint', 'true')
    runBoot()
    expect([root.dataset.theme, root.getAttribute('data-sidebar-tint')]).toEqual(['dark', 'on'])
  })
})
