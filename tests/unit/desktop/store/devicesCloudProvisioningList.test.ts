// @vitest-environment jsdom
// While the cloud computer is being set up or woken (its manager asked every 3 s), each answer also reads the device list
// again: the new machine's row shows up as soon as it is there (❌ only when a device_changed revision comes). Once it is
// awake and listed online, the manager's answers no longer read the list.
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { notifyManager } from '@tanstack/react-query'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
import { readCachedDevices } from '../../../../apps/desktop/src/store/devicesCache'
import { DevicesProvider } from '../../../../apps/desktop/src/store/devices'
import { cloudComputer } from '../../../../apps/desktop/src/lib/cloudComputer'
import { createNode, createReactHarness } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({ listDevices: vi.fn(), state: vi.fn() }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { listDevices: mocks.listDevices } }))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: vi.fn().mockResolvedValue({}), listMyAccountProjects: vi.fn().mockResolvedValue([]) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ subscribeAccountRevision: () => () => undefined }) }))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerClient', () => ({ rendererCloudComputerClient: () => ({ state: () => mocks.state() }) }))

const device = (id: string) => ({ device_id: id, label: id, hostname: id, platform: 'linux', status: 'online', last_seen_at: '2026-10-29T00:00:00.000Z', is_online: true, capabilities: { terminals: [], runtimes: [] }, machine_id: null, session_digest: [] })
const snapshot = (state: 'provisioning' | 'awake', deviceId: string | null) => ({ state, deviceId, error: null, since: null })

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  window.localStorage.clear()
  queryClient.clear(); followRendererSession('SIGNED_IN', 'owner')
  mocks.listDevices.mockReset().mockResolvedValue([device('a')])
  mocks.state.mockReset().mockResolvedValue(snapshot('awake', 'a'))
})

it('reads the device list again with each answer of the manager while the cloud computer is being set up', async () => {
  const harness = createReactHarness()
  await harness.render(createNode(DevicesProvider, {}))
  await vi.waitFor(() => expect(readCachedDevices()).toHaveLength(1))
  mocks.listDevices.mockClear()

  mocks.listDevices.mockResolvedValue([device('a'), device('cloud')])
  mocks.state.mockResolvedValue(snapshot('provisioning', null))
  await act(async () => { await cloudComputer.refresh() })
  await vi.waitFor(() => expect(readCachedDevices()).toHaveLength(2))
  expect(mocks.listDevices).toHaveBeenCalled()

  mocks.listDevices.mockClear()
  mocks.state.mockResolvedValue(snapshot('awake', 'cloud'))
  await act(async () => { await cloudComputer.refresh() })
  await act(async () => { await Promise.resolve() })
  expect(mocks.listDevices).not.toHaveBeenCalled()
  harness.cleanup()
})
