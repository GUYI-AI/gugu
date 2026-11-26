// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyUpgradeEvent, openSshLink, signInSshMachine, onSshMachineSignedIn, requestSshServerUpgrade, sshLinkProblems } from '@/lib/sshLinkChannel'
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
