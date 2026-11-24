// The page a remote task opens on before its workspace is ready, the toasts that name an unreachable machine and the
// session page's condition row say the machine's state in the sidebar dot's words, only while its line is not open.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ link: 'connecting', connection: 'connecting' as string | null }))
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: (projectId: string) => (projectId === 'remote' ? 'device-1' : null) } }))
vi.mock('@renderer/lib/machine-clients', () => ({ machineLinkState: () => state.link }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { device: () => ({ label: 'Linux 2', lastSeenAt: null }), connectionState: () => state.connection },
}))
vi.mock('@renderer/features/sessions/workspace-backend/workspace-surface', () => ({ workspaceReachLabel: () => null }))
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`,
}))

const { machineUnavailableLabel } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/machine-unavailable-label')

beforeEach(() => { state.link = 'connecting'; state.connection = 'connecting' })

describe('machineUnavailableLabel', () => {
  it('says the machine is being connected to while its first line is still coming up, not that it is offline', () => {
    expect(machineUnavailableLabel('remote')).toBe('remoteHost.status.connecting {"device":"Linux 2"}')
  })
  it('says reconnecting, offline, as the machine state is', () => {
    state.link = 'closed'; state.connection = 'reconnecting'
    expect(machineUnavailableLabel('remote')).toBe('remoteHost.status.reconnecting {"device":"Linux 2"}')
    state.connection = 'offline'
    expect(machineUnavailableLabel('remote')).toBe('remoteHost.status.offlineNever {"device":"Linux 2"}')
    state.connection = null
    expect(machineUnavailableLabel('remote')).toBe('remoteHost.status.offlineNever {"device":"Linux 2"}')
  })
  it('says nothing once the line is open, or for a task on this machine', () => {
    state.link = 'open'; state.connection = 'connected'
    expect(machineUnavailableLabel('remote')).toBeNull()
    expect(machineUnavailableLabel('local')).toBeNull()
  })
})
