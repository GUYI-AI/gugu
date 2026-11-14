import { beforeEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ platform: 'ios', enabled: true, configure: vi.fn(), hostState: vi.fn(), hostCall: vi.fn(), stopHost: vi.fn(), addListener: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.platform !== 'web', getPlatform: () => native.platform, isPluginAvailable: () => native.enabled }, registerPlugin: (name: string) => { if (name !== 'GuguAgent') throw Error('Unexpected plugin'); return native } }))
import { iosAgentClient } from '../../../../apps/desktop/src/mobile/ios-host/iosAgentClient'
const ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
const id = '40000000-0000-0000-0000-000000000004'
const state = () => ({ ownerId, deviceId: binding.deviceId, status: 'failed', ready: false, taskTimeline: false, sessions: [], error: 'Delivery is not connected', errorCode: 'delivery_not_connected' })
beforeEach(() => { vi.resetAllMocks(); native.platform = 'ios'; native.enabled = true })
describe('iOS-only GuguAgent wire', () => {
  it.each(['web', 'android', 'missing'])('rejects unavailable %s before native', async target => {
    native.platform = target === 'missing' ? 'ios' : target; native.enabled = target !== 'missing'
    expect(iosAgentClient.available()).toBe(false)
    await expect(iosAgentClient.configure(binding)).rejects.toMatchObject({ code: 'unavailable' })
    expect(native.configure).not.toHaveBeenCalled()
  })
  it('passes only expected binding and display label, retaining real unavailable state', async () => {
    native.configure.mockResolvedValue(state())
    const input = { ...binding, accessToken: 'never-send', grants: { calendar: true } }
    expect(await iosAgentClient.configure(input, 'My iPhone')).toMatchObject({ ready: false, taskTimeline: false, errorCode: 'delivery_not_connected' })
    expect(native.configure).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding, device: { label: 'My iPhone' } })
    expect('authSession' in iosAgentClient).toBe(false)
  })
  it.each(['owner', 'device', 'ready', 'timeline', 'error', 'sessions'])('rejects malformed state %s', async field => {
    const value: Record<string, unknown> = state()
    if (field === 'owner') value.ownerId = installationId
    if (field === 'device') value.deviceId = 'other'
    if (field === 'ready') value.ready = true
    if (field === 'timeline') value.taskTimeline = true
    if (field === 'error') value.error = {}
    if (field === 'sessions') value.sessions = [null]
    native.hostState.mockResolvedValue(value)
    await expect(iosAgentClient.state(binding)).rejects.toMatchObject({ code: 'invalid_native_reply' })
  })
  it('retains original UUID and structured uncertain call failure', async () => {
    const error = { code: 'admission_uncertain', message: 'Keep original request', admission: 'uncertain' }
    native.hostCall.mockResolvedValue({ error })
    expect(await iosAgentClient.call(binding, id, 'appSettings.get', ['notifications'])).toEqual({ error })
    expect(native.hostCall).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding, id, channel: 'appSettings.get', args: ['notifications'] })
  })
  it('rebuilds full binding for all three scoped entries without owner-only or extra fields', async () => {
    const input = { ...binding, accessToken: 'never-send', generation: 'not-a-native-generation' }
    native.hostState.mockResolvedValue(state()); native.stopHost.mockResolvedValue({}); native.hostCall.mockResolvedValue({ result: null })
    await iosAgentClient.state(input); await iosAgentClient.stop(input)
    await iosAgentClient.call(input, id, 'appSettings.update', ['notifications', { enabled: false, sound: true }])
    expect(native.hostState).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding })
    expect(native.stopHost).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding })
    expect(native.hostCall).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding, id, channel: 'appSettings.update', args: ['notifications', { enabled: false, sound: true }] })
    for (const method of [native.hostState, native.stopHost, native.hostCall]) expect(method.mock.calls[0][0].expectedBinding).not.toBe(input)
  })
  it('retains the captured scope if caller changes its object while a state reply is pending', async () => {
    let resolve!: (value: unknown) => void
    native.hostState.mockImplementation(() => new Promise(done => { resolve = done }))
    const input = { ...binding }, pending = iosAgentClient.state(input)
    input.ownerId = installationId; input.installationId = ownerId; input.deviceId = 'changed'
    resolve(state())
    expect(await pending).toMatchObject({ ownerId, deviceId: binding.deviceId })
    expect(native.hostState).toHaveBeenCalledExactlyOnceWith({ expectedBinding: binding })
  })
  it.each([{}, { result: null, error: {} }, { error: { code: 'failed' } }])('rejects ambiguous hostCall envelope %#', async value => {
    native.hostCall.mockResolvedValue(value)
    await expect(iosAgentClient.call(binding, id, 'appSettings.get', ['notifications'])).rejects.toMatchObject({ code: 'invalid_native_reply' })
  })
  it('accepts native empty stop ack and preserves a rejected stop', async () => {
    native.stopHost.mockResolvedValue({}); await expect(iosAgentClient.stop(binding)).resolves.toBeUndefined()
    const failure = { code: 'stop_failed' }; native.stopHost.mockRejectedValue(failure)
    await expect(iosAgentClient.stop(binding)).rejects.toBe(failure)
    native.stopHost.mockResolvedValue({ stopped: true })
    await expect(iosAgentClient.stop(binding)).rejects.toMatchObject({ code: 'invalid_native_reply' })
  })
  it('treats matched events only as a wake and removes its listener', async () => {
    const remove = vi.fn(async () => {}), wake = vi.fn()
    native.addListener.mockResolvedValue({ remove })
    const stop = await iosAgentClient.listen(binding, wake), event = native.addListener.mock.calls[0][1]
    event({ ...state(), ownerId: installationId }); event({ ...state(), deviceId: 'other' }); event(null)
    expect(wake).not.toHaveBeenCalled()
    event({ ownerId, deviceId: binding.deviceId, ready: 'old-untrusted-event' })
    expect(wake).toHaveBeenCalledExactlyOnceWith()
    await stop(); expect(remove).toHaveBeenCalledOnce()
  })
})
