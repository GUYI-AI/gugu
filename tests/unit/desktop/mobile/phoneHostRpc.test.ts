import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocked = vi.hoisted(() => ({ native: true, ownerId: 'owner', hostCall: vi.fn(), remote: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => mocked.ownerId }))
vi.mock('../../../../apps/desktop/src/lib/deviceRpc', () => ({ callDeviceRpc: mocked.remote }))
vi.mock('../../../../apps/desktop/src/mobile/phone-device/phoneDeviceSettings', () => ({ thisPhoneDeviceId: (ownerId: string) => `phone-${ownerId}` }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({ phoneAgentAvailable: () => mocked.native, nativeAgent: { hostCall: mocked.hostCall } }))
import { invokePhoneHost } from '../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc'
import { createDeviceRpcRequester } from '../../../../packages/core/src/cloud/deviceRpcRequester'
import { installIOSLocalHostRoute } from '../../../../apps/desktop/src/mobile/ios-host/iosLocalHostRoute'
import type { IOSAgentClient } from '../../../../apps/desktop/src/mobile/ios-host/iosAgentClient'

beforeEach(() => { mocked.native = true; mocked.ownerId = 'owner'; mocked.hostCall.mockReset(); mocked.remote.mockReset() })
afterEach(() => { vi.useRealTimers() })
describe('phone host uses the existing method contract without a workspace pipe', () => {
  it.each(['phone-owner', 'another-phone'].flatMap(device => ['accepted', 'rejected'].map(admission => ({ device, admission }))))('retains a late $admission from $device after the outbox display deadline', async ({ device, admission }) => {
    vi.useFakeTimers()
    let reply!: (value: unknown) => void
    mocked.hostCall.mockImplementation(() => new Promise(resolve => { reply = resolve }))
    const requester = createDeviceRpcRequester({ userId: async () => 'owner', newRequestId: () => 'transport-id', openPipe: async (_device, handlers) => {
      reply = value => handlers.onMessage({ payload: { type: 'taskhost.call:reply', request_id: 'transport-id', ...value as object } })
      return { send: async () => {}, close: () => {} }
    } })
    mocked.remote.mockImplementation((target, type, payload, options) => requester.call(target, type, payload, options))
    let state: unknown = 'pending'
    const pending = invokePhoneHost(device, 'sessionTimeline.sessionSend', [{ clientRequestId: 'original-input' }])
      .then(value => { state = value }, error => { state = error })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(state).toBe('pending')
    const error = { code: 'same-code', message: 'late decision', admission }
    const result = { accepted: true }
    reply(admission === 'rejected' ? { error } : { result: device === 'phone-owner' ? result : { value: result } })
    await pending
    expect(state).toMatchObject(admission === 'rejected' ? error : result)
    expect(vi.getTimerCount()).toBe(0)
    requester.closeAll()
  })
  it.each(['rejected', 'uncertain', undefined])('preserves the admission decision %s over both phone transports', async admission => {
    const error = { code: 'same-code', message: 'same reason', ...(admission ? { admission } : {}) }
    mocked.hostCall.mockResolvedValue({ error })
    mocked.remote.mockResolvedValue({ error })
    for (const device of ['phone-owner', 'another-phone']) {
      await expect(invokePhoneHost(device, 'sessionTimeline.sessionSend', [])).rejects.toMatchObject({ code: 'same-code', admission: admission ?? 'uncertain' })
    }
  })
  it('calls the exact current owner native host directly and preserves request id', async () => {
    mocked.hostCall.mockResolvedValue({ result: { id: 'made' } })
    await expect(invokePhoneHost('phone-owner', 'sessionTimeline.sessionCreate', [{ prompt: 'hello' }], 'retry-id')).resolves.toEqual({ id: 'made' })
    expect(mocked.hostCall).toHaveBeenCalledWith({ ownerId: 'owner', id: 'retry-id', channel: 'sessionTimeline.sessionCreate', args: [{ prompt: 'hello' }] })
    expect(mocked.remote).not.toHaveBeenCalled()
  })
  it('calls another phone through taskhost.call once, and never routes it to this phone', async () => {
    mocked.remote.mockResolvedValue({ result: { value: { sessions: [] } } })
    await expect(invokePhoneHost('another-phone', 'sessionTimeline.sessionsList', [])).resolves.toEqual({ sessions: [] })
    expect(mocked.remote).toHaveBeenCalledWith('another-phone', 'taskhost.call', { channel: 'sessionTimeline.sessionsList', args: [] }, { timeoutMs: 12_000 })
    expect(mocked.hostCall).not.toHaveBeenCalled()
  })
  it('does not fall back to a second transport after native failure', async () => {
    mocked.hostCall.mockResolvedValue({ error: { code: 'host_not_ready', message: '宿主尚未就绪' } })
    await expect(invokePhoneHost('phone-owner', 'sessionTimeline.sessionsList', [])).rejects.toThrow('尚未就绪')
    expect(mocked.remote).not.toHaveBeenCalled()
  })
  it('rejects a remote receipt without its result, rather than claiming success', async () => {
    mocked.remote.mockResolvedValue({ result: {} })
    await expect(invokePhoneHost('another-phone', 'sessionTimeline.sessionsList', [])).rejects.toThrow('尚未返回操作结果')
  })
  it('retries only startup catalog reads and keeps the request identity', async () => {
    vi.useFakeTimers()
    mocked.hostCall.mockResolvedValueOnce({ error: { code: 'host_not_ready', message: 'starting' } }).mockResolvedValue({ result: { projects: [] } })
    const pending = invokePhoneHost('phone-owner', 'sessionTimeline.sessionCreateOptions', [], 'catalog-request')
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toEqual({ projects: [] })
    expect(mocked.hostCall).toHaveBeenCalledTimes(2)
    expect(mocked.hostCall.mock.calls.every(([request]) => request.id === 'catalog-request' && request.ownerId === 'owner')).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a lost local reply and ignores a late receipt', async () => {
    vi.useFakeTimers()
    let reply: (value: unknown) => void = () => {}
    mocked.hostCall.mockImplementation(() => new Promise((resolve) => { reply = resolve }))
    const pending = invokePhoneHost('phone-owner', 'sessionTimeline.sessionCreateOptions', [], 'lost-request')
    const failed = expect(pending).rejects.toMatchObject({ code: 'host_call_timeout', requestId: 'lost-request' })
    await vi.advanceTimersByTimeAsync(12_000)
    await failed
    reply({ result: { projects: ['late'] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocked.hostCall).toHaveBeenCalledTimes(1)
    expect(mocked.remote).not.toHaveBeenCalled()
  })
  it('never retries a creation mutation on host_not_ready', async () => {
    mocked.hostCall.mockResolvedValue({ error: { code: 'host_not_ready', message: 'starting' } })
    await expect(invokePhoneHost('phone-owner', 'sessionTimeline.sessionCreate', [{ prompt: 'once' }], 'create-once')).rejects.toMatchObject({ code: 'host_not_ready' })
    expect(mocked.hostCall).toHaveBeenCalledTimes(1)
  })
  it('stops startup retrying at the shared read deadline', async () => {
    vi.useFakeTimers()
    mocked.hostCall.mockResolvedValue({ error: { code: 'host_not_ready', message: 'starting' } })
    const pending = invokePhoneHost('phone-owner', 'sessionTimeline.sessionCreateModels', [])
    const failed = expect(pending).rejects.toMatchObject({ code: 'host_call_timeout' })
    await vi.advanceTimersByTimeAsync(12_000)
    await failed
    const count = mocked.hostCall.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocked.hostCall).toHaveBeenCalledTimes(count)
    expect(mocked.remote).not.toHaveBeenCalled()
  })
})

describe('iOS local permission transport', () => {
  let detach = () => {}
  afterEach(() => detach())
  function ios() {
    mocked.native = false
    const binding = { ownerId: 'owner', installationId: 'install', deviceId: 'phone-install-owner' }
    let publication = { status: 'ready', binding }
    const call = vi.fn().mockResolvedValue({ result: { accepted: true } })
    detach = installIOSLocalHostRoute({ getSnapshot: () => publication }, { available: () => true, call } as unknown as IOSAgentClient)
    return { binding, call, retire() { publication = { status: 'publishing', binding } } }
  }
  it('approves on this iOS installation with its exact binding and original request ID', async () => {
    const f = ios(), args = [{ requestId: 'one-use-calendar-request', option: 'approve' }]
    await expect(invokePhoneHost(f.binding.deviceId, 'sessionTimeline.sessionRespond', args, 'original-response-id')).resolves.toEqual({ accepted: true })
    expect(f.call).toHaveBeenCalledExactlyOnceWith(f.binding, 'original-response-id', 'sessionTimeline.sessionRespond', args)
    expect(mocked.hostCall).not.toHaveBeenCalled(); expect(mocked.remote).not.toHaveBeenCalled()
  })
  it('keeps another phone or owner on the existing remote transport', async () => {
    const f = ios()
    mocked.remote.mockResolvedValue({ result: { value: { accepted: false } } })
    await invokePhoneHost('another-phone', 'sessionTimeline.sessionsList', [])
    mocked.ownerId = 'another-owner'
    await invokePhoneHost(f.binding.deviceId, 'sessionTimeline.sessionsList', [])
    expect(f.call).not.toHaveBeenCalled(); expect(mocked.remote).toHaveBeenCalledTimes(2)
  })
  it('refuses a late approval receipt after owner publication retires without using another transport', async () => {
    const f = ios()
    let resolve!: (value: unknown) => void
    f.call.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = invokePhoneHost(f.binding.deviceId, 'sessionTimeline.sessionRespond', [], 'same-request')
    const failed = expect(pending).rejects.toMatchObject({ code: 'stale_context', admission: 'uncertain' })
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce())
    f.retire(); resolve({ result: { accepted: true } }); await failed
    expect(mocked.remote).not.toHaveBeenCalled(); expect(mocked.hostCall).not.toHaveBeenCalled()
  })
  it('preserves native rejection and never retries the approval over the network', async () => {
    const f = ios()
    f.call.mockResolvedValue({ error: { code: 'not_granted', message: 'Wrong task', admission: 'rejected' } })
    await expect(invokePhoneHost(f.binding.deviceId, 'sessionTimeline.sessionRespond', [])).rejects.toMatchObject({ code: 'not_granted', admission: 'rejected' })
    expect(f.call).toHaveBeenCalledOnce(); expect(mocked.remote).not.toHaveBeenCalled()
  })
})
