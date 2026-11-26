// The page a remote task opens on before its workspace is ready, the toasts that name an unreachable machine and the
// session page's condition row say the machine's state in the sidebar dot's words, only while its line is not open.
import type { SshLinkState } from '@/lib/sshLink'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  link: 'connecting', connection: 'connecting' as string | null,
  sshLink: null as SshLinkState | null, failedUpdate: false,
}))
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: (projectId: string) => (projectId === 'remote' ? 'device-1' : null) } }))
vi.mock('@renderer/lib/machine-clients', () => ({ machineLinkState: () => state.link }))
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    device: () => ({
      label: 'Linux 2', lastSeenAt: null, isOnline: true, sshLink: state.sshLink,
      serverUpdate: state.failedUpdate ? { state: 'failed', version: '2' } : undefined,
    }),
    connectionState: () => state.connection,
  },
}))
vi.mock('@renderer/features/sessions/workspace-backend/local-workspace-backend', () => ({ localWorkspaceBackend: {} }))
vi.mock('@renderer/features/browser/browser-session-store', () => ({ browserSessionStore: {} }))
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`,
}))

const { machineUnavailableLabel } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/machine-unavailable-label')

beforeEach(() => {
  state.link = 'connecting'; state.connection = 'connecting'; state.sshLink = null; state.failedUpdate = false
})

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
  it('keeps the live recovery action above the composer when an older update has failed', async () => {
    const { ensureMachineWorkspaceBackend } = await import('@renderer/features/remote-hosts/workspace/machine-workspace-backend')
    const { setWorkspaceReachResolver } = await import('@renderer/features/sessions/workspace-backend/workspace-surface')
    ensureMachineWorkspaceBackend()
    try {
      state.link = 'closed'
      state.failedUpdate = true
      for (const [sshLink, connection, key] of [
        ['signInRequired', 'sign-in', 'remoteHost.status.signInRequired'],
        ['hostKeyChanged', 'hostKeyChanged', 'remoteHost.ssh.hostKeyChanged'],
        ['notRunning', 'notRunning', 'remoteHost.ssh.notRunning'],
        ['unreachable', 'reconnecting', 'remoteHost.status.reconnecting'],
        ['updating', 'updating', 'remoteHost.status.updating'],
        ['updateFailed', 'update-failed', 'remoteHost.status.updateFailed'],
        [null, 'outdated', 'remoteHost.status.updateFailed'],
      ] as const) {
        state.sshLink = sshLink
        state.connection = connection
        expect(machineUnavailableLabel('remote')?.split(' ')[0]).toBe(key)
      }
      state.link = 'open'
      state.connection = 'connected'
      expect(machineUnavailableLabel('remote')).toBeNull()
    } finally {
      setWorkspaceReachResolver(() => null)
    }
  })
})
