// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { IOSHostRuntimeSnapshot, IOSHostOwnerSource } from '../../../../apps/desktop/src/mobile/ios-host/iosHostRuntimeStore'
import type { IOSOwnerBinding } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient'
import { startIOSHostDirectory } from '../../../../apps/desktop/src/mobile/ios-host/iosHostDirectory'
import { directoryDevices, directoryRows, liveDeviceSessions, publishDirectoryDevices, retainDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { ownedAgentConversation } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { device } from '../../../support/testHarness'

const ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
const agent = { agentUserId: '40000000-0000-0000-0000-000000000004', sessionId: '50000000-0000-0000-0000-000000000005', chatId: '60000000-0000-0000-0000-000000000006', displayName: 'Phone Agent', modelId: 'model', status: 'idle' }
function fixture() {
  const runtimeListeners = new Set<() => void>(), ownerListeners = new Set<() => void>()
  let publication: ReturnType<IOSHostOwnerSource['getSnapshot']> = { status: 'ready', binding }
  let state: IOSHostRuntimeSnapshot = { phase: 'configured', binding,
    host: { ownerId, deviceId: binding.deviceId, status: 'ready', ready: true, taskTimeline: true, sessions: [agent], project: { id: 'project', name: 'Phone', path: '/phone/tasks' }, lastHeartbeatAt: 1, error: null, errorCode: null },
    settings: { status: 'unknown', meta: null, error: null }, error: null }
  const runtime = { getSnapshot: () => state, subscribe: (fn: () => void) => { runtimeListeners.add(fn); return () => { runtimeListeners.delete(fn) } } }
  const owner = { getSnapshot: () => publication, subscribe: (fn: () => void) => { ownerListeners.add(fn); return () => { ownerListeners.delete(fn) } } }
  return { runtime, owner, runtimeListeners, ownerListeners,
    setOwner(next: typeof publication) { publication = next; ownerListeners.forEach(fn => fn()) },
    setState(patch: Partial<IOSHostRuntimeSnapshot>) { state = { ...state, ...patch }; runtimeListeners.forEach(fn => fn()) },
    state: () => state }
}
const stops: Array<() => void> = []
afterEach(() => { stops.splice(0).forEach(stop => stop()); retainDeviceSessions([]); publishDirectoryDevices([]) })

describe('the App-owned iOS host session directory', () => {
  it('opens an Agent conversation through the real shared directory, using the native session and chat ids', async () => {
    const f = fixture(); publishDirectoryDevices([device(binding.deviceId, [], { is_online: true, capabilities: { host_kind: 'phone', terminals: [], runtimes: ['pi'] } })])
    stops.push(startIOSHostDirectory(f.runtime, f.owner, () => true))
    const rows = directoryRows(directoryDevices(), liveDeviceSessions())
    expect(rows).toHaveLength(1)
    expect(rows[0].session).toMatchObject({ conversationId: agent.sessionId, chatId: agent.chatId, agent: { userId: agent.agentUserId }, supported: true })
    await expect(ownedAgentConversation(agent.agentUserId, { rows, localContext: async () => null })).resolves.toMatchObject({ kind: 'remote', deviceId: binding.deviceId, session: { conversationId: agent.sessionId } })
  })
  it('publishes no local sessions without the host capability', () => {
    const f = fixture(); stops.push(startIOSHostDirectory(f.runtime, f.owner, () => false))
    expect(liveDeviceSessions()[binding.deviceId]).toBeUndefined()
  })
  it.each(['owner', 'installation'])('withdraws the old account immediately when %s binding changes, before native finishes', kind => {
    const f = fixture(); stops.push(startIOSHostDirectory(f.runtime, f.owner, () => true))
    const other: IOSOwnerBinding = kind === 'owner' ? { ...binding, ownerId: agent.agentUserId, deviceId: `phone-${installationId}-${agent.agentUserId}` }
      : { ...binding, installationId: agent.agentUserId, deviceId: `phone-${agent.agentUserId}-${ownerId}` }
    f.setOwner({ status: 'ready', binding: other })
    expect(liveDeviceSessions()[binding.deviceId]).toBeUndefined()
    f.setState({ host: { ...f.state().host!, sessions: [agent] } })
    expect(Object.keys(liveDeviceSessions())).toEqual([])
  })
  it('does not publish a native host for another owner or installation, or a malformed phone binding', () => {
    const f = fixture(); stops.push(startIOSHostDirectory(f.runtime, f.owner, () => true))
    for (const patch of [{ ownerId: agent.agentUserId }, { deviceId: 'another-phone' }]) {
      f.setState({ host: { ...f.state().host!, ...patch } }); expect(liveDeviceSessions()[binding.deviceId]).toBeUndefined()
    }
    const malformed = { ...binding, deviceId: 'another-phone' }
    f.setOwner({ status: 'ready', binding: malformed }); f.setState({ binding: malformed, host: { ...f.state().host!, ownerId, deviceId: malformed.deviceId } })
    expect(Object.keys(liveDeviceSessions())).toEqual([])
  })
  it('keeps a same-owner interrupted reading cached, without claiming the host is connected', () => {
    const f = fixture(); stops.push(startIOSHostDirectory(f.runtime, f.owner, () => true))
    f.setState({ host: { ...f.state().host!, status: 'failed', ready: false, taskTimeline: false, error: 'Connection closed', sessions: [{ ...agent, status: 'interrupted' }] } })
    expect(liveDeviceSessions()[binding.deviceId]).toMatchObject({ cached: true, connected: false, hostOnline: false, error: 'Connection closed', sessions: [{ supported: false, recordState: 'harness-unsupported', agentStatus: 'interrupted' }] })
  })
  it('removes only its own rows on logout/unmount and ignores callbacks from detached observations', () => {
    const f = fixture(); updateDeviceSessions('remote-other', { sessions: [], loading: false })
    const stop = startIOSHostDirectory(f.runtime, f.owner, () => true)
    f.setOwner({ status: 'retiring', binding: null }); expect(liveDeviceSessions()[binding.deviceId]).toBeUndefined()
    f.setOwner({ status: 'ready', binding }); expect(liveDeviceSessions()[binding.deviceId]).toBeDefined()
    const late = [...f.runtimeListeners][0]; stop(); late()
    expect(Object.keys(liveDeviceSessions())).toEqual(['remote-other'])
    expect(f.runtimeListeners.size + f.ownerListeners.size).toBe(0)
  })
})
