// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  owner: { status: 'ready', binding: { ownerId: 'owner', installationId: 'install', deviceId: 'phone' } },
  host: { binding: { ownerId: 'owner', installationId: 'install' }, settings: { status: 'ready', meta: { value: { enabled: true, sound: false } } } },
  chat: { chatMessages: true, sound: true },
  native: { configure: vi.fn(), suspend: vi.fn(), status: vi.fn(), register: vi.fn(), addListener: vi.fn() },
  changed: [] as (() => void)[], foreground: null as (() => void) | null,
}))
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'ios', isPluginAvailable: () => true }, registerPlugin: () => state.native }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { subscribeAppForeground: (fn: () => void) => { state.foreground = fn; return () => {} } } }))
vi.mock('../../../../apps/desktop/src/lib/notificationSettings', () => ({ readNotificationSettings: () => state.chat,
  subscribeNotificationSettings: (fn: () => void) => { state.changed.push(fn); return () => {} } }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {} }))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/startIOSOwnerPublication', () => ({
  getIOSOwnerPublicationSnapshot: () => state.owner,
  subscribeIOSOwnerPublication: (fn: () => void) => { state.changed.push(fn); return () => {} },
}))
vi.mock('../../../../apps/desktop/src/mobile/ios-host/iosHostRuntime', () => ({ iosHostRuntime: {
  getSnapshot: () => state.host, subscribe: (fn: () => void) => { state.changed.push(fn); return () => {} },
} }))
import { startIOSPush } from '../../../../apps/desktop/src/mobile/ios-push/startIOSPush'
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
beforeEach(() => {
  vi.resetAllMocks(); state.changed = []; state.owner.status = 'ready'; state.host.settings.status = 'ready'
  state.native.status.mockResolvedValue({ visibleAlertsAllowed: true })
  state.native.configure.mockResolvedValue(undefined); state.native.suspend.mockResolvedValue(undefined)
  state.native.register.mockResolvedValue({}); state.native.addListener.mockResolvedValue({ remove: vi.fn() })
})
it('sends independent chat/task sounds from their actual preferences', async () => {
  const stop = startIOSPush(); await settle()
  expect(state.native.configure).toHaveBeenCalledWith({ expectedBinding: state.owner.binding,
    chatEnabled: true, chatSoundEnabled: true, taskEnabled: true, taskSoundEnabled: false })
  expect(state.native.register).toHaveBeenCalledOnce(); stop()
})
it('keeps registration unavailable without saved local task preferences', async () => {
  state.host.settings.status = 'unknown'
  const stop = startIOSPush(); await settle()
  expect(state.native.suspend).toHaveBeenCalledOnce()
  expect(state.native.configure).not.toHaveBeenCalled(); expect(state.native.register).not.toHaveBeenCalled(); stop()
})
it('does not register without visible OS authorization', async () => {
  state.native.status.mockResolvedValue({ visibleAlertsAllowed: false })
  const stop = startIOSPush(); await settle()
  expect(state.native.register).not.toHaveBeenCalled(); stop()
})
it('withdraws an async registration when the owner leaves', async () => {
  let finish!: () => void
  state.native.configure.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const stop = startIOSPush(); await settle()
  state.owner.status = 'waiting'; state.changed[0](); finish(); await settle()
  expect(state.native.register).not.toHaveBeenCalled(); expect(state.native.suspend).toHaveBeenCalled(); stop()
})
it('foreground reconciles canonical state and refreshes registration independently of APNs', async () => {
  const wake = vi.fn(); window.addEventListener('gugu:ios-push-reconcile', wake)
  const stop = startIOSPush(); await settle(); state.foreground?.(); await settle()
  expect(wake).toHaveBeenCalledTimes(2); expect(state.native.register).toHaveBeenCalledTimes(2)
  stop(); window.removeEventListener('gugu:ios-push-reconcile', wake)
})
