import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  device: { device_id: 'dev-1', is_current_device: true } as { device_id: string; is_current_device: boolean },
  sessionOfAgent: vi.fn(async () => ({ projectId: 'p1', sessionId: 's1' })),
  renameSession: vi.fn(async () => undefined),
}))
const row = (data: unknown) => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data, error: null }) }), maybeSingle: async () => ({ data, error: null }) }) }) }) })
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  getCurrentAuthUserId: async () => 'owner',
  identityDb: { from: (table: string) => row(table === 'users' ? { id: 'agent', device_id: h.device.device_id } : { device_id: h.device.device_id }) },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { listDevices: async () => [h.device] } }))
vi.mock('@gugu/core/cloud/devices', () => ({ isPhoneDevice: () => false }))
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: { sessionOfAgent: h.sessionOfAgent }, sessions: { renameSession: h.renameSession } }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ sessionTimeline: { sessionOfAgent: h.sessionOfAgent }, sessions: { renameSession: h.renameSession } }) }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({ confirmArchive: vi.fn() }))

import { renameOwnedAgent } from '../../../../apps/desktop/src/lib/archiveOwnedAgent'

describe('renameOwnedAgent picks the path by where the task runs', () => {
  beforeEach(() => { h.sessionOfAgent.mockClear(); h.renameSession.mockClear() })

  it('a task on this device is renamed on its host (the rename the tab makes)', async () => {
    h.device = { device_id: 'dev-1', is_current_device: true }
    await expect(renameOwnedAgent('agent', 'New')).resolves.toEqual({ deviceId: 'dev-1' })
    expect(h.renameSession).toHaveBeenCalledWith('s1', 'New')
  })

  it('a task on another device makes no call to it (it may be off): the caller writes the identity', async () => {
    h.device = { device_id: 'dev-2', is_current_device: false }
    await expect(renameOwnedAgent('agent', 'New')).resolves.toBeNull()
    expect(h.sessionOfAgent).not.toHaveBeenCalled()
    expect(h.renameSession).not.toHaveBeenCalled()
  })
})
