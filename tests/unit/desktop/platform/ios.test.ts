// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ addListener: vi.fn(), getState: vi.fn(), getInfo: vi.fn(), write: vi.fn(), checkPermissions: vi.fn(), schedule: vi.fn() }))
const calendarPlugins = vi.hoisted(() => ({ native: true, os: 'ios', names: new Set<string>() }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}), Capacitor: {
  isNativePlatform: () => calendarPlugins.native,
  getPlatform: () => calendarPlugins.os,
  isPluginAvailable: (name: string) => calendarPlugins.names.has(name),
} }))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/startIOSOwnerPublication', () => ({ getIOSOwnerPublicationSnapshot: () => ({ status: 'waiting', binding: null }) }))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: { checkPermissions: native.checkPermissions, schedule: native.schedule, addListener: native.addListener } }))
vi.mock('@capacitor/app', () => ({ App: native }))
vi.mock('@capacitor/clipboard', () => ({ Clipboard: { write: native.write } }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
import { iosPlatform } from '../../../../apps/desktop/src/platform/ios'

beforeEach(() => {
  vi.resetAllMocks()
  calendarPlugins.native = true; calendarPlugins.os = 'ios'; calendarPlugins.names.clear()
})

describe('iOS foreground client', () => {
  it('exposes calendar settings only when both native calendar and owner plugins are registered', () => {
    expect(iosPlatform.capabilities.calendarSettings).toBe(false)
    calendarPlugins.names.add('GuguCalendarPermissions')
    expect(iosPlatform.capabilities.calendarSettings).toBe(false)
    calendarPlugins.names.add('GuguIOSOwner')
    expect(iosPlatform.capabilities.calendarSettings).toBe(true)
    expect(iosPlatform.capabilities.phoneDevice).toBe(false)
    expect(iosPlatform.systemPermissions).toEqual([])
    calendarPlugins.os = 'android'
    expect(iosPlatform.capabilities.calendarSettings).toBe(false)
    calendarPlugins.os = 'ios'; calendarPlugins.native = false
    expect(iosPlatform.capabilities.calendarSettings).toBe(false)
  })
  it('does not expose Android host, market, update, watch, scan, share or notification entry points', () => {
    for (const key of ['phoneDevice', 'mobileApps', 'agentRuntime', 'appUpdates', 'backgroundWatch', 'barcodeScan', 'shareToApps', 'notifications', 'sessionHost'] as const) {
      expect(iosPlatform.capabilities[key], key).toBe(false)
    }
    expect(iosPlatform.authCallbacks).toBeUndefined()
    expect(iosPlatform.oauthBrowser).toBeUndefined()
    expect(iosPlatform.systemPermissions).toEqual([])
  })

  it('advertises visible notifications only with the native push plugin', () => {
    calendarPlugins.names.add('GuguPushNotifications')
    expect(iosPlatform.capabilities.notifications).toBe(true)
    expect(iosPlatform.systemPermissions).toEqual(['notifications'])
  })

  it('does not duplicate background APNs through the local outlet', async () => {
    native.checkPermissions.mockResolvedValue({ display: 'granted' })
    native.getState.mockResolvedValue({ isActive: false })
    await expect(iosPlatform.showNotification({ title: 'chat' })).resolves.toMatchObject({ displayed: false, error: 'APP_NOT_ACTIVE' })
    expect(native.schedule).not.toHaveBeenCalled()
  })
  it.each([false, true])('uses the one local outlet in foreground with silent=%s', async (silent) => {
    native.checkPermissions.mockResolvedValue({ display: 'granted' })
    native.getState.mockResolvedValue({ isActive: true })
    native.schedule.mockResolvedValue(undefined)
    await expect(iosPlatform.showNotification({ title: 'chat', silent })).resolves.toMatchObject({ displayed: true })
    expect(native.schedule).toHaveBeenCalledOnce()
    expect(native.schedule.mock.calls[0][0].notifications[0].sound).toBe(silent ? undefined : 'default')
  })
  it('does not assume foreground when the host state read fails', async () => {
    native.checkPermissions.mockResolvedValue({ display: 'granted' })
    native.getState.mockRejectedValue(new Error('state unavailable'))
    await expect(iosPlatform.showNotification({ title: 'chat' })).rejects.toThrow('state unavailable')
    expect(native.schedule).not.toHaveBeenCalled()
  })

  it('preserves a native clipboard failure instead of reporting a successful copy', async () => {
    const failure = new Error('clipboard refused')
    native.write.mockRejectedValueOnce(failure)
    await expect(iosPlatform.writeClipboardText('中文 😀')).rejects.toBe(failure)
    expect(native.write).toHaveBeenCalledWith({ string: '中文 😀' })
  })

  it('releases a resume listener even when registration finishes after unmount', async () => {
    let register!: (handle: { remove: () => Promise<void> }) => void
    native.addListener.mockReturnValueOnce(new Promise(resolve => { register = resolve }))
    const listener = vi.fn()
    const stop = iosPlatform.subscribeAppForeground(listener, vi.fn())
    stop()
    const remove = vi.fn().mockResolvedValue(undefined)
    register({ remove })
    await Promise.resolve()
    native.addListener.mock.calls[0][1]()
    expect(remove).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer inactive event with a late initial state', async () => {
    let resolveState!: (state: { isActive: boolean }) => void
    native.getState.mockReturnValueOnce(new Promise(resolve => { resolveState = resolve }))
    const remove = vi.fn().mockResolvedValue(undefined)
    native.addListener.mockResolvedValueOnce({ remove })
    const listener = vi.fn()
    const stop = iosPlatform.subscribeAppActive!(listener)
    native.addListener.mock.calls[0][1]({ isActive: false })
    resolveState({ isActive: true })
    await Promise.resolve()
    expect(listener.mock.calls).toEqual([[false]])
    stop()
    expect(remove).toHaveBeenCalledOnce()
  })
})
