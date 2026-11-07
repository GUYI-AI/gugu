import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  isNative: true, platform: 'ios', available: true, status: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => native.isNative,
    getPlatform: () => native.platform,
    isPluginAvailable: (name: string) => name === 'GuguCalendarPermissions' && native.available,
  },
  registerPlugin: (name: string) => {
    if (name !== 'GuguCalendarPermissions') throw new Error(`Unexpected native plugin ${name}`)
    return { status: native.status }
  },
}))

import { readIOSCalendarPermissionStatus } from '../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions'

beforeEach(() => {
  vi.clearAllMocks()
  native.isNative = true
  native.platform = 'ios'
  native.available = true
})

describe('iOS calendar permission discovery', () => {
  it.each([
    ['notDetermined', false, false], ['denied', false, false], ['restricted', false, false],
    ['writeOnly', false, true], ['fullAccess', true, true],
  ])('preserves actual %s OS state without granting category consent', async (authorization, os_readable, os_writable) => {
    native.status.mockResolvedValue({ authorization, os_readable, os_writable, connected: true })
    expect(await readIOSCalendarPermissionStatus()).toEqual({ authorization, os_readable, os_writable })
    expect(native.status).toHaveBeenCalledOnce()
  })

  it.each([
    null, {}, { authorization: 'unknown', os_readable: true, os_writable: true },
    { authorization: 'writeOnly', os_readable: true, os_writable: true },
    { authorization: 'fullAccess', os_readable: false, os_writable: true },
    { authorization: 'denied', os_readable: false, os_writable: 'false' },
  ])('rejects malformed or contradictory native permission state %#', async status => {
    native.status.mockResolvedValue(status)
    await expect(readIOSCalendarPermissionStatus()).rejects.toMatchObject({ code: 'invalid_native_status' })
  })

  it.each(['web', 'android', 'missing-plugin'])('does not call an unavailable native surface: %s', async target => {
    native.isNative = target !== 'web'
    native.platform = target === 'android' ? 'android' : 'ios'
    native.available = target !== 'missing-plugin'
    await expect(readIOSCalendarPermissionStatus()).rejects.toMatchObject({ code: 'unavailable' })
    expect(native.status).not.toHaveBeenCalled()
  })

  it('preserves native owner/installation rejection instead of returning an empty or granted state', async () => {
    const failure = { code: 'stale_context', message: 'Owner installation changed' }
    native.status.mockRejectedValue(failure)
    await expect(readIOSCalendarPermissionStatus()).rejects.toBe(failure)
  })
})
