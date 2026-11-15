import { describe, expect, it, vi } from 'vitest'
import { IOSHostRuntimeStore } from '../../../../apps/desktop/src/mobile/ios-host/iosHostRuntimeStore'
import type { IOSAgentClient, IOSHostState } from '../../../../apps/desktop/src/mobile/ios-host/iosAgentClient'
import type { IOSOwnerBinding } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient'
function binding(ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'): IOSOwnerBinding {
  return { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
}
function state(b: IOSOwnerBinding, error = 'Delivery is not connected'): IOSHostState {
  return { ownerId: b.ownerId, deviceId: b.deviceId, status: 'failed', ready: false, taskTimeline: false, sessions: [], project: null, lastHeartbeatAt: null, error, errorCode: 'delivery_not_connected' }
}
const meta = (value = { enabled: false, sound: true }) => ({ value, defaults: { enabled: true, sound: true }, overrides: value })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(ready = true) {
  let current: { status: string; binding: IOSOwnerBinding | null } = { status: ready ? 'ready' : 'publishing', binding: ready ? binding() : null }
  const observers = new Set<() => void>(), wakes: (() => void)[] = [], removes: ReturnType<typeof vi.fn>[] = []
  const client = { available: vi.fn(() => true), configure: vi.fn(async b => state(b)), state: vi.fn(async b => state(b)),
    call: vi.fn(async () => ({ error: { code: 'settings_unavailable', message: 'Not persisted', admission: 'rejected' } })),
    stop: vi.fn(async () => {}), listen: vi.fn(async (_b: IOSOwnerBinding, wake: () => void): Promise<() => Promise<void>> => { wakes.push(wake); const remove = vi.fn(async () => {}); removes.push(remove); return remove }) }
  const store = new IOSHostRuntimeStore({ getSnapshot: () => current, subscribe: callback => { observers.add(callback); return () => { observers.delete(callback) } } }, client as unknown as IOSAgentClient)
  return { store, client, wakes, removes, publish(status: string, b: IOSOwnerBinding | null = null) { current = { status, binding: b }; observers.forEach(callback => callback()) } }
}
describe('OwnerPublication-ready iOS host projection', () => {
  it('does not configure while publication is pending or native plugin absent', async () => {
    const f = fixture(false); const detach = f.store.start()
    expect(f.store.getSnapshot().phase).toBe('waiting'); expect(f.client.configure).not.toHaveBeenCalled()
    f.client.available.mockReturnValue(false); f.publish('ready', binding())
    expect(f.store.getSnapshot().phase).toBe('unavailable'); expect(f.client.configure).not.toHaveBeenCalled(); detach()
  })
  it('preserves ready=false and its delivery error while still reading local settings', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    expect(f.store.getSnapshot()).toMatchObject({ phase: 'configured', host: { ready: false, taskTimeline: false, errorCode: 'delivery_not_connected' }, settings: { status: 'unknown', meta: null, error: { code: 'settings_unavailable' } } })
    expect(f.client.call).toHaveBeenCalledWith(binding(), expect.any(String), 'appSettings.getWithMeta', ['notifications'])
    expect(f.client.stop).not.toHaveBeenCalled(); detach()
  })
  it('keeps the same native host across binding refresh and subscription detach/remount', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    f.publish('publishing'); expect(f.store.getSnapshot().host).toBeNull()
    f.publish('ready', binding()); await f.store.whenIdle()
    expect(f.client.configure).toHaveBeenCalledOnce(); expect(f.client.stop).not.toHaveBeenCalled()
    detach(); const detachAgain = f.store.start(); await f.store.whenIdle()
    expect(f.client.configure).toHaveBeenCalledOnce(); expect(f.client.stop).not.toHaveBeenCalled(); detachAgain()
  })
  it('rejects late configure result for the old owner instead of changing the new owner', async () => {
    const f = fixture(), old = deferred<IOSHostState>()
    f.client.configure.mockImplementationOnce(() => old.promise)
    const detach = f.store.start(), first = f.store.whenIdle().catch(() => undefined)
    const next = binding('20000000-0000-0000-0000-000000000002')
    f.publish('ready', next); await f.store.whenIdle(); old.resolve(state(binding(), 'old result')); await first
    expect(f.store.getSnapshot().binding).toEqual(next); expect(f.store.getSnapshot().host?.ownerId).toBe(next.ownerId)
    expect(f.client.listen).toHaveBeenCalledOnce(); detach()
  })
  it('does not reuse configuration for a changed native installation', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    const next = binding(undefined, '50000000-0000-0000-0000-000000000005')
    f.publish('ready', next); await f.store.whenIdle()
    expect(f.client.configure).toHaveBeenCalledTimes(2); expect(f.store.getSnapshot().binding).toEqual(next); detach()
  })
  it('checks publication again if a configured-state subscriber changes owner before listener I/O', async () => {
    const f = fixture(), next = binding('20000000-0000-0000-0000-000000000002')
    const unsubscribe = f.store.subscribe(() => {
      const snapshot = f.store.getSnapshot()
      if (snapshot.phase === 'configured' && snapshot.binding?.ownerId === binding().ownerId) f.publish('ready', next)
    })
    const detach = f.store.start(), first = f.store.whenIdle().catch(() => undefined)
    await first; await f.store.whenIdle()
    expect(f.client.listen.mock.calls.map(call => call[0])).toEqual([next])
    expect(f.store.getSnapshot().binding).toEqual(next); unsubscribe(); detach()
  })
  it('reconfigures after native confirms the same phone binding has no live host', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    f.publish('publishing'); f.client.state.mockRejectedValueOnce({ code: 'host_not_ready' })
    f.publish('ready', binding()); await f.store.whenIdle()
    expect(f.client.configure).toHaveBeenCalledTimes(2); expect(f.client.stop).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().phase).toBe('configured'); detach()
  })
  it('never configures an old binding after its delayed missing-host response', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    const old = deferred<IOSHostState>(); f.publish('publishing'); f.client.state.mockImplementationOnce(() => old.promise)
    f.publish('ready', binding()); const first = f.store.whenIdle().catch(() => undefined)
    const next = binding('20000000-0000-0000-0000-000000000002'); f.publish('ready', next); await f.store.whenIdle()
    old.reject({ code: 'host_not_ready' }); await first
    expect(f.client.configure.mock.calls.map(call => call[0])).toEqual([binding(), next]); detach()
  })
  it('uses events only to reread state and ignores an old owner listener', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    const oldWake = f.wakes[0]
    f.publish('ready', binding('20000000-0000-0000-0000-000000000002')); await f.store.whenIdle()
    const before = f.client.state.mock.calls.length; oldWake()
    expect(f.client.state.mock.calls).toHaveLength(before)
    f.wakes[1](); await f.store.whenIdle(); expect(f.client.state.mock.calls).toHaveLength(before + 1); detach()
  })
  it('does not let an older state read replace a newer read for the same binding', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    const old = deferred<IOSHostState>()
    f.client.state.mockImplementationOnce(() => old.promise).mockResolvedValueOnce(state(binding(), 'new result'))
    f.wakes[0](); const first = f.store.whenIdle(); f.wakes[0](); await f.store.whenIdle()
    old.resolve(state(binding(), 'old result')); await first
    expect(f.store.getSnapshot().host?.error).toBe('new result'); detach()
  })
  it('propagates failed stop, blocks automatic same-binding restart and retries the actual stop', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    f.client.stop.mockRejectedValueOnce({ code: 'stop_failed' })
    await expect(f.store.stopHost()).rejects.toMatchObject({ code: 'stop_failed' })
    expect(f.store.getSnapshot()).toMatchObject({ phase: 'failed', error: { code: 'stop_failed' } })
    f.publish('publishing'); f.publish('ready', binding()); expect(f.client.configure).toHaveBeenCalledOnce()
    await f.store.retry()
    expect(f.client.stop).toHaveBeenCalledTimes(2); expect(f.client.configure).toHaveBeenCalledTimes(2)
    expect(f.store.getSnapshot().phase).toBe('configured'); detach()
  })
  it('does not let an old stop response clear a new owner projection', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    const old = deferred<void>(); f.client.stop.mockImplementationOnce(() => old.promise)
    const stop = f.store.stopHost(), next = binding('20000000-0000-0000-0000-000000000002')
    f.publish('ready', next); await f.store.whenIdle(); old.resolve(); await stop
    expect(f.store.getSnapshot()).toMatchObject({ phase: 'configured', binding: next }); detach()
  })
  it('does not use the remembered configuration to stop after publication is withdrawn', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    f.publish('publishing')
    await expect(f.store.stopHost()).rejects.toMatchObject({ code: 'stale_context' })
    expect(f.client.stop).not.toHaveBeenCalled(); expect(f.store.getSnapshot().phase).toBe('waiting')
    detach(); await expect(f.store.stopHost()).rejects.toMatchObject({ code: 'stale_context' })
    expect(f.client.stop).not.toHaveBeenCalled(); expect(f.store.getSnapshot().phase).toBe('inactive')
  })
  it('publishes settings only after successful persisted readback', async () => {
    const f = fixture(); f.client.call.mockResolvedValue({ result: meta() } as never)
    const detach = f.store.start(); await f.store.whenIdle()
    expect(f.store.getSnapshot().settings).toMatchObject({ status: 'ready', meta: meta() })
    f.client.call.mockResolvedValueOnce({ result: null } as never).mockResolvedValueOnce({ result: meta({ enabled: true, sound: false }) } as never)
    await f.store.updateNotifications({ enabled: true, sound: false }, '40000000-0000-0000-0000-000000000004')
    expect(f.store.getSnapshot().settings.meta?.value).toEqual({ enabled: true, sound: false }); detach()
  })
  it('rejects a late settings mutation after account change without publishing its value', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    const reply = deferred<unknown>(); f.client.call.mockImplementationOnce(() => reply.promise as never)
    const update = f.store.updateNotifications({ enabled: true, sound: false }, '40000000-0000-0000-0000-000000000004')
    expect(f.store.getSnapshot().settings).toMatchObject({ status: 'loading', meta: null })
    const next = binding('20000000-0000-0000-0000-000000000002'); f.publish('ready', next); await f.store.whenIdle()
    reply.resolve({ result: null }); await expect(update).rejects.toMatchObject({ code: 'stale_context' })
    expect(f.store.getSnapshot()).toMatchObject({ binding: next, settings: { status: 'unknown', meta: null } }); detach()
  })
  it('does not retain a listener whose asynchronous installation finishes after detach', async () => {
    const f = fixture(), handle = deferred<() => Promise<void>>(), remove = vi.fn(async () => {})
    f.client.listen.mockImplementationOnce(() => handle.promise)
    const detach = f.store.start()
    for (let i = 0; i < 20 && !f.client.listen.mock.calls.length; ++i) await Promise.resolve()
    expect(f.client.listen).toHaveBeenCalledOnce(); detach()
    handle.resolve(remove); await f.store.whenIdle().catch(() => undefined)
    expect(remove).toHaveBeenCalledOnce(); expect(f.client.stop).not.toHaveBeenCalled()
  })
  it('withdraws native state after an authoritative reread fails', async () => {
    const f = fixture(); const detach = f.store.start(); await f.store.whenIdle()
    f.client.state.mockRejectedValueOnce({ code: 'stale_context' }); f.wakes[0]()
    await expect(f.store.whenIdle()).rejects.toMatchObject({ code: 'stale_context' })
    expect(f.store.getSnapshot()).toMatchObject({ phase: 'failed', host: null, settings: { status: 'unknown', meta: null } }); detach()
  })
})
