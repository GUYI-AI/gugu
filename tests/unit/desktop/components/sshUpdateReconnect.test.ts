// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { applyUpgradeEvent, openSshLink, requestSshServerUpgrade, sshLinkProblems } from '@/lib/sshLinkChannel'
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
    await openSshLink(id, handlers).ready
    expect(sshLinkProblems.get().has(id)).toBe(false)
  },
)
