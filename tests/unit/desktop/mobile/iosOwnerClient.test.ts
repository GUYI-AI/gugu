import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ isNative: true, platform: 'ios', available: true,
  publishSession: vi.fn(), getBinding: vi.fn(), retireSession: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.isNative, getPlatform: () => native.platform,
    isPluginAvailable: (name: string) => name === 'GuguIOSOwner' && native.available },
  registerPlugin: (name: string) => {
    if (name !== 'GuguIOSOwner') throw new Error('Unexpected plugin')
    return native
  },
}))
import { iosOwnerClient } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient'

const ownerId = '10000000-0000-0000-0000-000000000001'
const installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
beforeEach(() => { vi.resetAllMocks(); native.isNative = true; native.platform = 'ios'; native.available = true })

describe('GuguIOSOwner client', () => {
  it.each(['web', 'android', 'missing'])('stays unavailable on %s without native calls', async target => {
    native.isNative = target !== 'web'; native.platform = target === 'android' ? 'android' : 'ios'; native.available = target !== 'missing'
    expect(iosOwnerClient.available()).toBe(false)
    await expect(iosOwnerClient.publish({ ownerId, accessToken: 'synthetic-short-access' })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(iosOwnerClient.getBinding(ownerId)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(iosOwnerClient.retire(ownerId)).rejects.toMatchObject({ code: 'unavailable' })
    expect(native.publishSession).not.toHaveBeenCalled(); expect(native.getBinding).not.toHaveBeenCalled(); expect(native.retireSession).not.toHaveBeenCalled()
  })

  it('passes only owner and short access and returns only the validated native binding', async () => {
    native.publishSession.mockResolvedValue({ available: true, binding: { ...binding, accessToken: 'native-extra' }, extra: true })
    const input = { ownerId, accessToken: 'synthetic-short-access', refresh_token: 'never-send', session: { refreshToken: 'never-send' } }
    expect(await iosOwnerClient.publish(input)).toEqual(binding)
    expect(native.publishSession).toHaveBeenCalledExactlyOnceWith({ ownerId, accessToken: 'synthetic-short-access' })
  })

  it.each([
    null, {}, { available: false, binding: null }, { available: true, binding: null },
    { available: true, binding: { ...binding, ownerId: '90000000-0000-0000-0000-000000000009' } },
    { available: true, binding: { ...binding, deviceId: installationId } },
    { available: true, binding: { ...binding, installationId: 'not-native-installation' } },
  ])('rejects incomplete or mismatched publication reply %#', async reply => {
    native.publishSession.mockResolvedValue(reply)
    await expect(iosOwnerClient.publish({ ownerId, accessToken: 'synthetic-short-access' })).rejects.toMatchObject({ code: 'invalid_native_reply' })
  })

  it('reads an unavailable binding only from explicit false/null', async () => {
    native.getBinding.mockResolvedValue({ available: false, binding: null })
    expect(await iosOwnerClient.getBinding(ownerId)).toBeNull()
    expect(native.getBinding).toHaveBeenCalledExactlyOnceWith({ ownerId })
  })

  it('reads an available validated binding without a publication request', async () => {
    native.getBinding.mockResolvedValue({ available: true, binding })
    expect(await iosOwnerClient.getBinding(ownerId)).toEqual(binding)
    expect(native.publishSession).not.toHaveBeenCalled()
  })

  it.each([{ available: false }, { available: false, binding }, { available: 'true', binding }])('rejects ambiguous binding absence %#', async reply => {
    native.getBinding.mockResolvedValue(reply)
    await expect(iosOwnerClient.getBinding(ownerId)).rejects.toMatchObject({ code: 'invalid_native_reply' })
  })

  it('preserves native stale-owner rejection', async () => {
    const failure = { code: 'stale_context', message: 'Native current owner differs' }
    native.getBinding.mockRejectedValue(failure)
    await expect(iosOwnerClient.getBinding(ownerId)).rejects.toBe(failure)
  })

  it('accepts retirement only after explicit native acknowledgement', async () => {
    native.retireSession.mockResolvedValue({ retired: true })
    await expect(iosOwnerClient.retire(ownerId)).resolves.toBeUndefined()
    expect(native.retireSession).toHaveBeenCalledExactlyOnceWith({ ownerId })
  })

  it.each([undefined, null, {}, { retired: false }, { retired: 'true' }])('rejects a missing retirement acknowledgement %#', async reply => {
    native.retireSession.mockResolvedValue(reply)
    await expect(iosOwnerClient.retire(ownerId)).rejects.toMatchObject({ code: 'invalid_native_reply' })
  })

  it('keeps native stop failure rejected instead of turning it into a retired state', async () => {
    const failure = { code: 'stop_failed' }
    native.retireSession.mockRejectedValue(failure)
    await expect(iosOwnerClient.retire(ownerId)).rejects.toBe(failure)
  })

  it('rejects missing or malformed caller input without invoking native', async () => {
    await expect(iosOwnerClient.publish({ ownerId, accessToken: '' })).rejects.toMatchObject({ code: 'invalid_native_reply' })
    await expect(iosOwnerClient.publish({ ownerId: 'page-owner', accessToken: 'synthetic-short-access' })).rejects.toMatchObject({ code: 'invalid_native_reply' })
    expect(native.publishSession).not.toHaveBeenCalled()
  })
})
