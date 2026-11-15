// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PREFERENCE_STORAGE_KEYS,
  takeDeviceSettings,
  type DeviceSettingsAnswer,
  type DeviceSettingsHandover,
  type LegacyDevicePreferences,
} from '../../../../apps/desktop/shared/device-preferences'

/**
 * @@@device-preferences — one store per shell. Desktop: main's app settings (preload hands them over before the first
 * frame, after carrying the old localStorage keys over once); web / phone: localStorage. Never one, else the other.
 */
const ipc = vi.hoisted(() => {
  const listeners = new Set<(data: { key: string }) => void>()
  const stored: Record<string, unknown> = {}
  let releaseUpdate: (() => void) | null = null
  return {
    listeners,
    stored,
    hold: () => new Promise<void>((resolve) => { releaseUpdate = resolve }),
    release: () => releaseUpdate?.(),
    getWithMeta: vi.fn(async (key: string) => ({ value: stored[key], defaults: stored[key], overrides: {} })),
    getAll: vi.fn(async () => Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, { value, defaults: value, overrides: {} }]))),
    update: vi.fn(async (key: string, value: unknown) => { stored[key] = value }),
  }
})
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { appSettings: { getWithMeta: ipc.getWithMeta, getAll: ipc.getAll, update: ipc.update }, themePacks: { imported: async () => [], stylesheet: async () => '' } },
  rpcOn: () => ({ appSettings: { getWithMeta: ipc.getWithMeta } }),
  events: { on: (_channel: unknown, cb: (data: { key: string }) => void) => { ipc.listeners.add(cb); return () => ipc.listeners.delete(cb) } },
}))
vi.mock('@/lib/errorSummaryReporting', () => ({ reportHandledError: vi.fn() }))

const meta = (value: unknown) => ({ value, defaults: value, overrides: {} })
const handover = (over: Partial<Record<string, unknown>> = {}): DeviceSettingsHandover => {
  const values: Record<string, unknown> = {
    theme: 'dark',
    locale: 'en-US',
    interface: { sidebarTint: true, trayBadge: false, hideContextBar: false },
    themePackSlots: {},
    chatNotifications: { chatMessages: true, sound: false },
    assistant: { meetingReminder: true, hiddenIdeasEntries: [] },
    ...over,
  }
  Object.assign(ipc.stored, values)
  return { settings: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, meta(value)])) as DeviceSettingsHandover['settings'], themePackCss: '' }
}
const broadcast = (key: string) => { for (const listener of ipc.listeners) listener({ key }) }
const OLD_KEYS = Object.values(PREFERENCE_STORAGE_KEYS) as string[]

async function load() {
  return await import('../../../../apps/desktop/src/lib/devicePreferences')
}

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  vi.resetModules()
  ipc.listeners.clear()
  for (const key of Object.keys(ipc.stored)) delete ipc.stored[key]
  ipc.update.mockClear()
  ipc.getWithMeta.mockClear()
  ipc.getAll.mockClear()
})
afterEach(async () => {
  delete (window as { guguDeviceSettings?: unknown }).guguDeviceSettings
  vi.restoreAllMocks()
  ;(await import('../../../../apps/desktop/src/lib/replica')).queryClient.clear()
  // The next test's shared setup imports the language runtime again: in a shell without a handover.
  vi.resetModules()
})

describe('preload, desktop: the one-time migration of the old keys', () => {
  const answer = (legacy: LegacyDevicePreferences, settled: DeviceSettingsAnswer['settled']): DeviceSettingsAnswer => {
    void legacy
    return { handover: handover(), settled }
  }

  it('upgrade start: the old values are sent to main, and each one main settled is deleted', () => {
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.theme, 'dark')
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.locale, 'en-US')
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.themePackCss, ':root{}')
    localStorage.setItem('gugu.assistant.ideasEntry:a1', 'hidden')
    localStorage.setItem('gugu.readModel.v1:device', '{}')
    let sent: LegacyDevicePreferences | null = null
    const exposed = takeDeviceSettings(localStorage, (legacy) => { sent = legacy; return answer(legacy, ['theme', 'locale', 'hiddenIdeasEntries']) })
    expect(sent).toEqual({ theme: 'dark', locale: 'en-US', hiddenIdeasEntries: ['a1'] })
    expect(exposed.handover?.settings.theme.value).toBe('dark')
    // Gone: the adopted keys, and the derived stylesheet main derives now. Untouched: anything else.
    for (const key of [...OLD_KEYS, 'gugu.assistant.ideasEntry:a1']) expect(localStorage.getItem(key)).toBeNull()
    expect(localStorage.getItem('gugu.readModel.v1:device')).toBe('{}')
  })

  it('an old key main did not settle (it could not write it) stays for the next start; no answer keeps them all', () => {
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.theme, 'dark')
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.locale, 'en-US')
    takeDeviceSettings(localStorage, (legacy) => answer(legacy, ['locale']))
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.theme)).toBe('dark')
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.locale)).toBeNull()
    expect(takeDeviceSettings(localStorage, () => null)).toEqual({ handover: null })
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.theme)).toBe('dark')
  })
})

describe('desktop shell: app settings', () => {
  it('the handed-over values are there synchronously, before any read answers', async () => {
    window.guguDeviceSettings = { handover: handover() }
    const { devicePreferences } = await load()
    expect(devicePreferences.backend).toBe('appSettings')
    expect(devicePreferences.read('theme')).toMatchObject({ state: 'value', value: 'dark' })
    expect(devicePreferences.read('locale')).toMatchObject({ state: 'value', value: 'en-US' })
    expect(devicePreferences.read('sidebarTint')).toMatchObject({ state: 'value', value: true })
    expect(devicePreferences.read('trayBadge')).toMatchObject({ state: 'value', value: false })
  })

  it('never touches the old localStorage keys: reads come from main, writes go to main', async () => {
    window.guguDeviceSettings = { handover: handover() }
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.theme, 'light')
    const get = vi.spyOn(Storage.prototype, 'getItem')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    const { devicePreferences } = await load()
    devicePreferences.write('theme', 'system')
    devicePreferences.write('sidebarTint', false)
    expect(devicePreferences.read('theme')).toMatchObject({ state: 'value', value: 'system' })
    await vi.waitFor(() => expect(ipc.update).toHaveBeenCalledWith('theme', 'system'))
    expect(ipc.update).toHaveBeenCalledWith('interface', expect.objectContaining({ sidebarTint: false, trayBadge: false }))
    const touched = [...get.mock.calls, ...set.mock.calls].map(([key]) => key)
    expect(touched.filter((key) => OLD_KEYS.includes(key) || key.startsWith('gugu.assistant.ideasEntry:'))).toEqual([])
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.theme)).toBe('light')
  })

  it('another window\'s change arrives as the settings broadcast and is read again', async () => {
    window.guguDeviceSettings = { handover: handover() }
    const { devicePreferences } = await load()
    let told = 0
    devicePreferences.subscribe(() => { told += 1 })
    ipc.stored.locale = 'zh-CN'
    broadcast('locale')
    await vi.waitFor(() => expect(devicePreferences.read('locale')).toMatchObject({ state: 'value', value: 'zh-CN' }))
    expect(told).toBeGreaterThan(0)
  })

  it('a broadcast arriving while this window\'s write is on its way does not put the older value back', async () => {
    window.guguDeviceSettings = { handover: handover() }
    const { devicePreferences } = await load()
    const held = ipc.hold()
    ipc.update.mockImplementationOnce(async (key: string, value: unknown) => { await held; ipc.stored[key] = value })
    devicePreferences.write('sidebarTint', false)
    // Main answered an earlier write: its broadcast lands while this one is still on its way (main still says true).
    const reads = ipc.getWithMeta.mock.calls.length
    broadcast('interface')
    await Promise.resolve()
    expect(ipc.getWithMeta.mock.calls.length).toBe(reads)
    expect(devicePreferences.read('sidebarTint')).toMatchObject({ state: 'value', value: false })
    ipc.release()
    await vi.waitFor(() => expect(ipc.stored.interface).toMatchObject({ sidebarTint: false }))
    await vi.waitFor(() => expect(devicePreferences.read('sidebarTint')).toMatchObject({ state: 'value', value: false }))
  })

  it('the handed-over keys are not kept in the snapshot: preload is their only first value', async () => {
    window.guguDeviceSettings = { handover: handover() }
    ipc.stored.terminal = { enabled: true }
    await load()
    const client = await import('../../../../apps/desktop/src/session/renderer/features/settings/app-settings-client')
    await client.prefetchAllAppSettings()
    const kept = Object.values(JSON.parse(localStorage.getItem('gugu.readModel.v1:device') ?? '{}') as Record<string, { key: unknown[] }>)
    expect(kept.filter((entry) => entry.key[0] === 'appSettings').map((entry) => entry.key[2])).toEqual(['terminal'])
  })
})

describe('web / phone shell: localStorage', () => {
  it('without a handover the store is localStorage, read and written under its keys; app settings are never asked', async () => {
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.theme, 'plain-white')
    localStorage.setItem(PREFERENCE_STORAGE_KEYS.chatNotifications, JSON.stringify({ messages: false }))
    const { devicePreferences } = await load()
    expect(devicePreferences.backend).toBe('localStorage')
    expect(devicePreferences.read('theme')).toMatchObject({ state: 'value', value: 'light' })
    expect(devicePreferences.read('chatNotifications')).toMatchObject({ state: 'value', value: { chatMessages: false, sound: true } })
    devicePreferences.write('sidebarTint', true)
    devicePreferences.write('hiddenIdeasEntries', ['a1'])
    expect(localStorage.getItem(PREFERENCE_STORAGE_KEYS.sidebarTint)).toBe('true')
    expect(localStorage.getItem('gugu.assistant.ideasEntry:a1')).toBe('hidden')
    expect(ipc.getWithMeta).not.toHaveBeenCalled()
    expect(ipc.getAll).not.toHaveBeenCalled()
    expect(ipc.update).not.toHaveBeenCalled()
  })
})
