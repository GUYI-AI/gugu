import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  isNative: true, platform: 'ios', available: true, status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.isNative,
    getPlatform: () => native.platform,
    isPluginAvailable: (name: string) => name === 'GuguCalendarPermissions' && native.available,
  },
  registerPlugin: (name: string) => {
    if (name !== 'GuguCalendarPermissions') throw new Error(`Unexpected native plugin ${name}`)
    return { status: native.status, connect: native.connect, disconnect: native.disconnect }
  },
}))

import { connectIOSCalendar, disconnectIOSCalendar, readIOSCalendarPermissionStatus } from '../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions'

const binding = { ownerId: '10000000-0000-0000-0000-000000000001', deviceId: 'phone-30000000-0000-0000-0000-000000000003-10000000-0000-0000-0000-000000000001', installationId: '30000000-0000-0000-0000-000000000003' }
const revision = '40000000-0000-0000-0000-000000000004'
const snapshot = (changes: Record<string, unknown> = {}) => ({
  authorization: 'fullAccess', os_readable: true, os_writable: true,
  binding, calendarConnected: false, calendarRevision: null, ...changes,
})

beforeEach(() => {
  vi.clearAllMocks()
  native.isNative = true
  native.platform = 'ios'
  native.available = true
})

describe('iOS calendar native state', () => {
  it.each([
    ['notDetermined', false, false], ['denied', false, false], ['restricted', false, false],
    ['writeOnly', false, true], ['fullAccess', true, true],
  ])('preserves actual %s OS state without granting category consent', async (authorization, os_readable, os_writable) => {
    const state = snapshot({ authorization, os_readable, os_writable })
    native.status.mockResolvedValue({ ...state, connected: true })
    expect(await readIOSCalendarPermissionStatus(binding.ownerId)).toEqual(state)
    expect(native.status).toHaveBeenCalledExactlyOnceWith({ ownerId: binding.ownerId })
    expect(native.connect).not.toHaveBeenCalled()
  })

  it('keeps the native selection distinct from subsequently revoked OS permission', async () => {
    const state = snapshot({ authorization: 'denied', os_readable: false, os_writable: false, calendarConnected: true, calendarRevision: revision })
    native.status.mockResolvedValue(state)
    expect(await readIOSCalendarPermissionStatus(binding.ownerId)).toEqual(state)
  })

  it.each([
    null, {}, snapshot({ authorization: 'unknown' }),
    snapshot({ authorization: 'writeOnly', os_readable: true }), snapshot({ os_readable: false }),
    snapshot({ os_writable: 'false' }), snapshot({ binding: { ...binding, ownerId: 'another-owner' } }),
    snapshot({ calendarConnected: 'true' }), snapshot({ calendarConnected: true }),
    snapshot({ calendarRevision: undefined }), snapshot({ calendarRevision: 'not-a-revision' }),
    snapshot({ binding: { ...binding, installationId: 'missing' } }),
  ])('rejects malformed or contradictory native state %#', async status => {
    native.status.mockResolvedValue(status)
    await expect(readIOSCalendarPermissionStatus(binding.ownerId)).rejects.toMatchObject({ code: 'invalid_native_status' })
  })

  it.each(['web', 'android', 'missing-plugin'])('does not call an unavailable native surface: %s', async target => {
    native.isNative = target !== 'web'
    native.platform = target === 'android' ? 'android' : 'ios'
    native.available = target !== 'missing-plugin'
    await expect(readIOSCalendarPermissionStatus(binding.ownerId)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(connectIOSCalendar(binding)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(disconnectIOSCalendar(binding)).rejects.toMatchObject({ code: 'unavailable' })
    expect(native.status).not.toHaveBeenCalled()
    expect(native.connect).not.toHaveBeenCalled()
    expect(native.disconnect).not.toHaveBeenCalled()
  })

  it('preserves native owner/installation rejection instead of returning a granted state', async () => {
    const failure = { code: 'stale_context', message: 'Owner installation changed' }
    native.status.mockRejectedValue(failure)
    await expect(readIOSCalendarPermissionStatus(binding.ownerId)).rejects.toBe(failure)
  })

  it('sends only the native expected binding and accepts a fully settled connection', async () => {
    const result = snapshot({ calendarConnected: true, calendarRevision: revision })
    native.connect.mockResolvedValue(result)
    expect(await connectIOSCalendar({ ...binding, confirmed: true, attemptId: 'caller-injected' } as typeof binding)).toEqual(result)
    expect(native.connect).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding })
    expect(native.status).not.toHaveBeenCalled()
  })

  it.each(['ownerId', 'deviceId', 'installationId'] as const)('rejects a connection result from a different %s', async field => {
    native.connect.mockResolvedValue(snapshot({ calendarConnected: true, calendarRevision: revision,
      binding: { ...binding, [field]: '90000000-0000-0000-0000-000000000009' } }))
    await expect(connectIOSCalendar(binding)).rejects.toMatchObject({ code: 'invalid_native_status' })
  })

  it.each([
    snapshot(), snapshot({ authorization: 'writeOnly', os_readable: false, calendarConnected: true, calendarRevision: revision }),
  ])('does not sign a connection from incomplete native settlement %#', async result => {
    native.connect.mockResolvedValue(result)
    await expect(connectIOSCalendar(binding)).rejects.toMatchObject({ code: 'invalid_native_status' })
  })

  it('disconnects category selection without claiming the OS permission was removed', async () => {
    const result = snapshot({ calendarRevision: revision })
    native.disconnect.mockResolvedValue(result)
    expect(await disconnectIOSCalendar(binding)).toEqual(result)
    expect(native.disconnect).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding })
  })

  it('rejects a disconnect response that still reports connected', async () => {
    native.disconnect.mockResolvedValue(snapshot({ calendarConnected: true, calendarRevision: revision }))
    await expect(disconnectIOSCalendar(binding)).rejects.toMatchObject({ code: 'invalid_native_status' })
  })

  it('does not retry a rejected native connection or expose the attempt', async () => {
    const failure = { code: 'os_permission', message: 'Full access required' }
    native.connect.mockRejectedValue(failure)
    await expect(connectIOSCalendar(binding)).rejects.toBe(failure)
    expect(native.connect).toHaveBeenCalledOnce()
    expect(native.status).not.toHaveBeenCalled()
  })

  it('rejects malformed expected identity before invoking native actions', async () => {
    await expect(readIOSCalendarPermissionStatus('owner-from-page')).rejects.toMatchObject({ code: 'invalid_native_status' })
    await expect(connectIOSCalendar({ ...binding, installationId: '' })).rejects.toMatchObject({ code: 'invalid_native_status' })
    expect(native.status).not.toHaveBeenCalled()
    expect(native.connect).not.toHaveBeenCalled()
  })
})
