// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyUpgradeEvent, openSshLink, signInSshMachine, onSshMachineSignedIn, requestSshServerUpgrade, sshLinkProblems, sshReinstallCommand, verifySshVersionOnHeartbeat } from '@/lib/sshLinkChannel'
import { device } from '../../../support/testHarness'
import { MIN_SERVER_PROTOCOL, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { SSH_LINK_CHANNELS } from '@/lib/sshLink'

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each(['waitingIdle', 'confirmationRequired', 'failed'] as const)(
  'keeps the reported %s outcome through a mismatched handshake and cooldown until reconnection',
  async phase => {
    const id = 'update-' + phase
    let connected = false
    const invoke = vi.fn(async (channel: string) => {
      if (channel === SSH_LINK_CHANNELS.open) return connected ? { ok: true } : { ok: false, reason: 'outdated' }
      if (channel === SSH_LINK_CHANNELS.upgrade) return false
    })
    vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
    const handlers = { onMessage: vi.fn(), onClosed: vi.fn() }

    applyUpgradeEvent({ deviceId: id, phase })
    await expect(openSshLink(id, handlers).ready).rejects.toMatchObject({ reason: 'outdated' })
    expect(await requestSshServerUpgrade(id)).toBe(false)
    expect(sshLinkProblems.get().get(id)).toBe(phase === 'failed' ? 'updateFailed' : phase)
    connected = true
    const link = openSshLink(id, handlers)
    await link.ready
    expect(sshLinkProblems.get().get(id)).toBeNull()
    link.close()
    expect(sshLinkProblems.get().has(id)).toBe(false)
  },
)

it('joins sign-in attempts and preserves the observed cause when the user cancels', async () => {
  const id = 'cancel-recovery'
  const invoke = vi.fn(async (channel: string) => channel === SSH_LINK_CHANNELS.signIn
    ? { ok: false, reason: 'signInRequired', cancelled: true } : { ok: false, reason: 'hostKeyChanged' })
  vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
  await expect(openSshLink(id, { onMessage: vi.fn(), onClosed: vi.fn() }).ready).rejects.toMatchObject({ reason: 'hostKeyChanged' })
  const first = signInSshMachine(id)
  expect(signInSshMachine(id)).toBe(first)
  await expect(first).resolves.toMatchObject({ cancelled: true })
  expect(sshLinkProblems.get().get(id)).toBe('hostKeyChanged')
  expect(invoke.mock.calls.filter(([channel]) => channel === SSH_LINK_CHANNELS.signIn)).toHaveLength(1)
})

it('does not wake a deliberately disconnected device on a late update or sign-in action', async () => {
  const id = 'paused-update'
  const invoke = vi.fn(async () => ({ ok: false, reason: 'disconnected' }))
  vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
  await expect(openSshLink(id, { onMessage: vi.fn(), onClosed: vi.fn() }).ready).rejects.toMatchObject({ reason: 'disconnected' })
  const wake = vi.fn()
  const off = onSshMachineSignedIn(wake)
  try {
    applyUpgradeEvent({ deviceId: id, phase: 'done' })
    expect(wake).not.toHaveBeenCalled()
    expect(sshLinkProblems.get().get(id)).toBe('disconnected')
    await expect(signInSshMachine(id)).resolves.toMatchObject({ reason: 'disconnected' })
    expect(invoke).toHaveBeenCalledTimes(1)
  } finally { off() }
})


it('reconciles a failed upgrade on a working SSH link without retrying the installer', async () => {
  const host = device('version-recovered', [])
  host.capabilities.remote_protocol = MIN_SERVER_PROTOCOL
  const invoke = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
  applyUpgradeEvent({ deviceId: host.device_id, phase: 'failed', reinstall: 'old installer' })
  await verifySshVersionOnHeartbeat(host)
  expect(invoke.mock.calls).toEqual([[SSH_LINK_CHANNELS.open, host.device_id, 'verify-version']])
  expect(sshLinkProblems.get().get(host.device_id)).toBeNull()
  expect(sshReinstallCommand(host.device_id)).toBeNull()
})

it('requires compatible peers and a settled update, even when the directory considers the host online', async () => {
  const host = device('version-still-old', [])
  const invoke = vi.fn().mockResolvedValue({ ok: false, reason: 'outdated' })
  vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
  applyUpgradeEvent({ deviceId: host.device_id, phase: 'failed' })
  await verifySshVersionOnHeartbeat(host)
  host.capabilities.remote_protocol = MIN_SERVER_PROTOCOL - 1
  await verifySshVersionOnHeartbeat(host)
  host.capabilities.remote_protocol = MIN_SERVER_PROTOCOL
  host.capabilities.min_client_protocol = REMOTE_PROTOCOL_VERSION + 1
  await verifySshVersionOnHeartbeat(host)
  delete host.capabilities.min_client_protocol
  host.capabilities.server_update = { state: 'failed', version: 'next' }
  await verifySshVersionOnHeartbeat(host)
  delete host.capabilities.server_update
  await verifySshVersionOnHeartbeat({ ...host, status: 'offline' })
  expect(invoke).not.toHaveBeenCalled()
  await verifySshVersionOnHeartbeat(host)
  await verifySshVersionOnHeartbeat(host)
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(sshLinkProblems.get().get(host.device_id)).toBe('updateFailed')
})

it('keeps a later update attempt when an earlier verification finishes', async () => {
  const host = device('version-race', [])
  host.capabilities.remote_protocol = MIN_SERVER_PROTOCOL
  let resolve!: (reply: { ok: true }) => void
  const invoke = vi.fn(() => new Promise(done => { resolve = done }))
  vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
  applyUpgradeEvent({ deviceId: host.device_id, phase: 'failed' })
  const checking = verifySshVersionOnHeartbeat(host)
  applyUpgradeEvent({ deviceId: host.device_id, phase: 'updating' })
  applyUpgradeEvent({ deviceId: host.device_id, phase: 'failed', reinstall: 'new installer' })
  resolve({ ok: true })
  await checking
  expect(sshLinkProblems.get().get(host.device_id)).toBe('updateFailed')
  expect(sshReinstallCommand(host.device_id)).toBe('new installer')
})
