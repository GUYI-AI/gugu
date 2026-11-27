// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyManager } from '@tanstack/react-query'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
import type { Device } from '@gugu/core/shared/types/chat'
import { MIN_SERVER_PROTOCOL } from '@gugu/core/cloud/serverMachineHealth'
import { applyUpgradeEvent, sshLinkProblems } from '../../../../apps/desktop/src/lib/sshLinkChannel'
import { SSH_LINK_CHANNELS } from '../../../../apps/desktop/src/lib/sshLink'
import { DevicesProvider } from '../../../../apps/desktop/src/store/devices'
import { useDevicesStore } from '../../../../apps/desktop/src/store/devicesContext'
import { writeCachedDevices } from '../../../../apps/desktop/src/store/devicesCache'
import { LocalDeviceUnidentifiedError } from '../../../../apps/desktop/src/lib/localDeviceIdentity'
import { createNode, createReactHarness } from '../../../support/testHarness'
// The devices read loads its module on first use: loaded here, so its answer lands inside the render's act whatever
// the machine's load (a first import outlasting act made React warn, which this cell reads as a failure).
await import('../../../../apps/desktop/src/store/devicesRead')
// The replica reads for the signed-in account, as the product publishes it.
;(await import('../../../../apps/desktop/src/lib/replica')).followRendererSession('SIGNED_IN', 'account-a')

const mocks = vi.hoisted(() => ({
  listDevices: vi.fn(),
  // The account project list also re-reads on identification (it subscribes itself): every subscriber is kept.
  identified: new Set<() => void>(),
}))

vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'account-a' } }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { listDevices: mocks.listDevices } }))
// The assistant marker's resubscription watch (myAssistant, signal tier) rides the account's private bus: no socket in a unit test.
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ useMyAssistant: () => ({ state: 'value', value: { agentId: null, provisionDeviceId: null }, stale: false, error: null }) }))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: async () => [], listMyAccountProjects: async () => [] }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ subscribeAccountRevision: () => () => undefined }),
}))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return {
    ...original,
    platform: new Proxy(original.platform, {
      get(target, key, receiver) {
        if (key === 'subscribeLocalDeviceIdentified') {
          return (listener: () => void) => { mocks.identified.add(listener); return () => { mocks.identified.delete(listener) } }
        }
        return Reflect.get(target, key, receiver)
      },
    }),
  }
})

function device(id: string, extra: Partial<Device> = {}): Device {
  return {
    device_id: id, label: id, hostname: id, platform: 'darwin', status: 'online', last_seen_at: '2026-10-27T00:00:00Z',
    capabilities: { runtimes: [] } as unknown as Device['capabilities'], machine_id: null, is_online: true, ...extra,
  } as Device
}

let seen: Device[] = []
function Probe() {
  seen = useDevicesStore().devices
  return null
}

/**
 * Beta 1040: on every start the first device read ran before the local host had the sign-in, came back with this
 * computer's row unmarked, and the session page took that row for another, offline computer — whose "projects" were
 * this computer's, dropped from the sidebar once it was recognized. Until it is identified, the list keeps the one it
 * had (its own row marked), and it is read again the moment the local host identifies it.
 */
describe('DevicesProvider', () => {
  let harness: ReturnType<typeof createReactHarness>
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() }); queryClient.clear(); followRendererSession('SIGNED_IN', 'account-a')
    localStorage.clear()
    seen = []
    mocks.identified.clear()
    harness = createReactHarness()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    harness.cleanup()
    consoleError.mockRestore()
  })

  it('keeps the cached list with its own row marked, reports no failure, and reads again once identified', async () => {
    writeCachedDevices([device('this-mac', { is_current_device: true }), device('d22', { is_current_device: false })])
    mocks.listDevices.mockReset().mockRejectedValueOnce(new LocalDeviceUnidentifiedError())

    await harness.render(createNode(DevicesProvider, {}, createNode(Probe)))
    await vi.waitFor(() => expect(mocks.listDevices).toHaveBeenCalledTimes(1))
    expect(seen.find((row) => row.device_id === 'this-mac')?.is_current_device).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()
    if (mocks.identified.size === 0) throw new Error('the provider does not listen for the identification')

    mocks.listDevices.mockResolvedValueOnce([
      device('this-mac', { is_current_device: true, label: 'renamed-mac' }),
      device('d22', { is_current_device: false }),
    ])
    await act(async () => { mocks.identified.forEach((listener) => listener()); await Promise.resolve() })
    await vi.waitFor(() => expect(mocks.listDevices).toHaveBeenCalledTimes(2))
    expect(seen.find((row) => row.device_id === 'this-mac')).toMatchObject({ is_current_device: true, label: 'renamed-mac' })
  })

  it('checks only unresolved versions while mounted and stops checking each recovered device', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const positive = 'upgraded'
    const negative = 'still-old'
    const healthy = device('healthy')
    const reported = (id: string, protocol: number, time: string) => {
      const row = device(id, { last_seen_at: time })
      row.capabilities.remote_protocol = protocol
      return row
    }
    let time = '2026-11-27T07:00:00Z'
    let endpointReady = false
    const invoke = vi.fn(async (channel: string, id: string) => {
      if (channel === SSH_LINK_CHANNELS.open) return id === positive && endpointReady ? { ok: true } : { ok: false, reason: 'outdated' }
      return []
    })
    vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => {} })
    mocks.listDevices.mockReset().mockImplementation(async ({ deviceIds }: { deviceIds?: string[] }) => {
      const rows = [healthy, reported(positive, MIN_SERVER_PROTOCOL, time), reported(negative, MIN_SERVER_PROTOCOL - 1, time)]
      return deviceIds ? rows.filter(row => deviceIds.includes(row.device_id)) : rows
    })
    const targetedReads = () => mocks.listDevices.mock.calls.flatMap(([options]) => options.deviceIds ? [options.deviceIds] : [])
    try {
      await harness.render(createNode(DevicesProvider, {}, createNode(Probe)))
      expect(targetedReads()).toEqual([])
      await act(async () => {
        applyUpgradeEvent({ deviceId: positive, phase: 'failed' })
        applyUpgradeEvent({ deviceId: negative, phase: 'failed' })
      })
      expect(targetedReads()).toContainEqual([negative, positive])
      expect(sshLinkProblems.get().get(positive)).toBe('updateFailed')
      expect(invoke).toHaveBeenCalledWith(SSH_LINK_CHANNELS.open, positive, 'verify-version')
      endpointReady = true
      time = '2026-11-27T07:00:30Z'
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(sshLinkProblems.get().get(positive)).toBeNull()
      expect(sshLinkProblems.get().get(negative)).toBe('updateFailed')
      expect(seen.find(row => row.device_id === positive)?.last_seen_at).toBe(time)
      expect(invoke).not.toHaveBeenCalledWith(SSH_LINK_CHANNELS.open, negative, 'verify-version')
      mocks.listDevices.mockClear()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(targetedReads()).toEqual([[negative]])
      await act(async () => { applyUpgradeEvent({ deviceId: negative, phase: 'done' }) })
      mocks.listDevices.mockClear()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(targetedReads()).toEqual([])
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })
})
