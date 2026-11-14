// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const source = vi.hoisted(() => ({ current: { status: 'publishing', binding: null } as { status: string; binding: { ownerId: string; deviceId: string; installationId: string } | null }, listeners: new Set<() => void>() }))
const native = vi.hoisted(() => ({ enabled: true, configure: vi.fn(), state: vi.fn(), call: vi.fn(), stop: vi.fn(), listen: vi.fn() }))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/startIOSOwnerPublication', () => ({
  getIOSOwnerPublicationSnapshot: () => source.current,
  subscribeIOSOwnerPublication: (callback: () => void) => { source.listeners.add(callback); return () => { source.listeners.delete(callback) } },
}))
vi.mock('../../../../apps/desktop/src/mobile/ios-host/iosAgentClient', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/mobile/ios-host/iosAgentClient')>(),
  iosAgentClient: { ...native, available: () => native.enabled },
}))
import { IOSHostRoot } from '../../../../apps/desktop/src/mobile/ios-host/IOSHostRoot'
import { iosHostRuntime, useIOSHostRuntimeSnapshot } from '../../../../apps/desktop/src/mobile/ios-host/iosHostRuntime'
const ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
function Reader() { const state = useIOSHostRuntimeSnapshot(); return createElement('output', null, `${state.phase}:${state.host?.ready ?? 'unknown'}:${state.settings.status}`) }
let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.clearAllMocks(); source.current = { status: 'publishing', binding: null }; native.enabled = true
  const state = { ownerId, deviceId: binding.deviceId, status: 'failed', ready: false, taskTimeline: false, sessions: [], project: null, lastHeartbeatAt: null, error: 'Delivery not connected', errorCode: 'delivery_not_connected' }
  native.configure.mockResolvedValue(state); native.state.mockResolvedValue(state); native.listen.mockResolvedValue(async () => {})
  native.call.mockResolvedValue({ error: { code: 'settings_unavailable', message: 'Not persisted', admission: 'rejected' } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
describe('independent iOS host root', () => {
  it('waits for actual publication and retains unavailable native truth in the rendered store', async () => {
    await act(async () => root.render(createElement('div', null, createElement(IOSHostRoot), createElement(Reader))))
    expect(container.textContent).toBe('waiting:unknown:unknown'); expect(native.configure).not.toHaveBeenCalled()
    await act(async () => { source.current = { status: 'ready', binding }; source.listeners.forEach(callback => callback()); await iosHostRuntime.whenIdle() })
    expect(container.textContent).toBe('configured:false:unknown')
    expect(native.configure).toHaveBeenCalledExactlyOnceWith(binding, undefined)
    expect(native.stop).not.toHaveBeenCalled()
  })
  it('detaches observations without stopping an active native host', async () => {
    source.current = { status: 'ready', binding }
    await act(async () => { root.render(createElement(IOSHostRoot)); await Promise.resolve() })
    await act(async () => { await iosHostRuntime.whenIdle() })
    await act(async () => root.render(null))
    expect(iosHostRuntime.getSnapshot().phase).toBe('inactive'); expect(source.listeners.size).toBe(0)
    expect(native.stop).not.toHaveBeenCalled()
  })
})
