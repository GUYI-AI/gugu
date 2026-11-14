import { afterEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ publish: vi.fn(), binding: vi.fn(), retire: vi.fn(), sourceStart: vi.fn(), sourceRefresh: vi.fn(),
  sourceLogout: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), foreground: vi.fn() }))
const ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: (name: string) => name === 'GuguIOSOwner' },
  registerPlugin: () => ({ publishSession: native.publish, getBinding: native.binding, retireSession: native.retire }),
}))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {
  getSnapshot: () => ({ status: 'authenticated', error: null, session: { user: { id: '10000000-0000-0000-0000-000000000001' },
    access_token: 'synthetic-short-access', refresh_token: 'never-forward', expires_at: 1_900_000_000 } }),
  subscribe: (listener: () => void) => { native.subscribe(listener); return native.unsubscribe },
  captureAuthHandoff: async () => {}, start: native.sourceStart, refresh: native.sourceRefresh, logout: native.sourceLogout,
} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { subscribeAppForeground: (listener: () => void) => { native.foreground(listener); return () => {} } } }))
import { getIOSOwnerPublicationSnapshot, retryIOSOwnerPublication, startIOSOwnerPublication, stopIOSOwnerPublication } from '../../../../apps/desktop/src/mobile/ios-runtime/startIOSOwnerPublication'
const flush = async () => { for (let i = 0; i < 24; ++i) await Promise.resolve() }
afterEach(async () => { native.retire.mockResolvedValue({ retired: true }); await stopIOSOwnerPublication(); vi.useRealTimers() })

it('retries a failed inactive stop by reopening only publication subscriptions and preserving the native retirement barrier', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
  native.publish.mockResolvedValue({ available: true, binding }); native.binding.mockResolvedValue({ available: true, binding })
  native.retire.mockResolvedValue({ retired: true })
  startIOSOwnerPublication(); await flush()
  expect(getIOSOwnerPublicationSnapshot()).toMatchObject({ status: 'ready', binding })
  native.retire.mockRejectedValueOnce({ code: 'stop_failed' })
  await expect(stopIOSOwnerPublication()).rejects.toMatchObject({ code: 'retirement_failed' })
  expect(getIOSOwnerPublicationSnapshot()).toMatchObject({ status: 'failed', binding: null })
  await retryIOSOwnerPublication()
  expect(getIOSOwnerPublicationSnapshot()).toMatchObject({ status: 'ready', binding })
  expect(native.retire).toHaveBeenCalledTimes(2)
  expect(native.subscribe).toHaveBeenCalledTimes(2)
  expect(native.publish).toHaveBeenCalledTimes(2)
  expect(native.sourceStart).not.toHaveBeenCalled(); expect(native.sourceRefresh).not.toHaveBeenCalled(); expect(native.sourceLogout).not.toHaveBeenCalled()
  expect(native.publish).toHaveBeenLastCalledWith({ ownerId, accessToken: 'synthetic-short-access' })
})
