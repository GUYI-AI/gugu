// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createReactHarness } from '../../support/testHarness'

/**
 * #1931 The numbers the phone's own 资料 rows showed reach the assistant App's 资料 there (`status.counts`): read from the
 * same sources, each a read state, only for the account whose assistant the layer shows.
 */

const world = vi.hoisted(() => ({
  devices: { devices: [{ device_id: 'mac', label: 'Mac' }, { device_id: 'cloud', label: 'Cloud', cloud_computer: true }], phones: [{ device_id: 'phone', label: 'Phone' }], loading: false, error: null as unknown },
  integrations: { data: null as unknown, error: null as unknown },
  chats: { status: 'ready', list: [] as unknown[] },
  projects: { status: 'loading', projects: [] as unknown[] } as Record<string, unknown>,
  capabilities: 'loading' as number | 'loading' | 'failed',
}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => world.devices }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneProfileData', () => ({ usePhoneIntegrations: () => ({ ...world.integrations, loading: false, retry: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/components/settings/channels/useChatChannels', () => ({ useChatChannels: () => world.chats }))
vi.mock('../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-store', () => ({ get accountProjectsStore() { return world.projects } }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ isHome: () => false }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneProjectRows', () => ({ phoneProjectRows: (rows: unknown[]) => rows }))
vi.mock('../../../apps/desktop/src/components/assistant/assistant-app-connections', () => ({ assistantApplicationCounts: () => ({ saved: 3, connected: 2 }) }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', async () => {
  const { useEffect } = await import('react')
  return { AssistantLibraryCount: ({ onCount }: { onCount: (read: unknown) => void }) => { useEffect(() => onCount(world.capabilities)); return null } }
})

import { PhoneAssistantCountsSource } from '../../../apps/desktop/src/mobile/assistant/PhoneAssistantCounts'
import { phoneAssistantLayer, resetPhoneAssistantLayerForTest } from '../../../apps/desktop/src/components/appSlot/phoneAssistantLayer'
import type { AppAssistantStatus } from '../../../apps/desktop/src/session/shared/extensions/assistant-binding'

const OWNER = '0a000000-0000-4000-8000-000000000049'
const FOUND = { assistant: 'found', name: 'Pip', avatar: null, tint: null, home: null, setup: null, preparing: false, cloudAvailable: true, member: null,
  loadError: null, ownerName: null, counts: null, connectors: null, nameMax: 30 } as unknown as AppAssistantStatus
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { resetPhoneAssistantLayerForTest(); h = createReactHarness() })
afterEach(() => h.cleanup())
const render = () => h.render(<PhoneAssistantCountsSource ownerId={OWNER} assistantId="a" machine={{ state: 'opening' } as never} cloudDeviceId="cloud" />)

it('hands the App the 资料 numbers as read states: never 0 for what is not read yet', async () => {
  phoneAssistantLayer.publishStatus({ ownerId: OWNER, status: FOUND })
  await render()
  expect(phoneAssistantLayer.status()?.status.counts).toEqual({
    // The assistant's cloud host is not one of the person's devices (as the 资料 row counted them).
    devices: { state: 'ready', value: 2 }, connectedApps: { state: 'loading' }, projects: { state: 'loading' }, capabilities: { state: 'loading' },
  })
  world.integrations = { data: { items: [], configured: {}, statuses: {} }, error: null }
  world.projects = { status: 'ready', projects: [{ chatId: 'p1' }, { chatId: 'p2' }] }
  world.capabilities = 4
  await render()
  expect(phoneAssistantLayer.status()?.status.counts).toEqual({
    devices: { state: 'ready', value: 2 }, connectedApps: { state: 'ready', value: { saved: 3, connected: 2 } }, projects: { state: 'ready', value: 2 }, capabilities: { state: 'ready', value: 4 },
  })
  world.devices = { ...world.devices, error: new Error('down') }
  world.projects = { status: 'error', projects: [] }
  await render()
  expect(phoneAssistantLayer.status()?.status.counts).toMatchObject({ devices: { state: 'unreadable' }, projects: { state: 'unreadable' } })
})

it('gives them only to the account the layer shows, with its assistant found; gone with the layer', async () => {
  await render()
  phoneAssistantLayer.publishStatus({ ownerId: '0b000000-0000-4000-8000-000000000049', status: FOUND })
  expect(phoneAssistantLayer.status()?.status.counts).toBeNull()
  phoneAssistantLayer.publishStatus({ ownerId: OWNER, status: { ...FOUND, assistant: 'none' } as AppAssistantStatus })
  expect(phoneAssistantLayer.status()?.status.counts).toBeNull()
  phoneAssistantLayer.publishStatus({ ownerId: OWNER, status: FOUND })
  expect(phoneAssistantLayer.status()?.status.counts).not.toBeNull()
  const heard = vi.fn()
  phoneAssistantLayer.onStatus(heard)
  await act(async () => { h.cleanup() })
  expect(heard).toHaveBeenCalled()
  expect(phoneAssistantLayer.status()?.status.counts).toBeNull()
  h = createReactHarness()
})
