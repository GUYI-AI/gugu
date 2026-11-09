// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { OfflineSessionSlotHost } from '@/components/chat/OfflineSessionSlotHost'
import { OfflineSessionSlot } from '@renderer/lib/offline-session-slot'

// Two rows of one computer (a new data directory is a new row; the old one stays) that both list the same session:
// the project directory was carried over, so its ids are the same on both.
const listed = (id: string) => [{ conversationId: id, title: 'Carried-over task', runtime: 'acp', supported: true, nativeInputVersion: 2 }]
const scope = vi.hoisted(() => ({ account: 'device-owner', devices: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/sessionPublication', async original => ({
  ...await original<object>(),
  getRendererSession: () => ({ user: { id: scope.account } }),
}))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: scope.devices, phones: [] }) }))
vi.mock('@/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/components/chat/ChatSummariesHost', () => ({ ChatSummariesHost: () => null }))
vi.mock('@/components/chat/NativeConversationReadHost', () => ({ NativeConversationReadHost: () => null }))
vi.mock('@/mobile/agent-watch/SessionTimelinePage', () => ({
  SessionTimelinePage: ({ device }: { device: { device_id: string; last_seen_at: string } }) =>
    <output data-timeline-device={device.device_id}>{device.last_seen_at}</output>,
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { localStorage.clear(); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); localStorage.clear() })

it('keeps the timeline on the machine the session page opened it from, not another row that lists the same session', async () => {
  const sessionId = 'carried-over-task'
  // The old row sorts first; the page's own machine just went offline (both rows now answer from their digests).
  scope.devices = [
    { device_id: 'old-row', label: 'mac1', is_online: false, last_seen_at: '2026-11-08T13:37:34Z', capabilities: {}, session_digest: listed(sessionId) },
    { device_id: 'this-row', label: 'mac1', is_online: false, last_seen_at: '2026-11-08T20:07:35Z', capabilities: {}, session_digest: listed(sessionId) },
  ]
  renderWithAppProviders(harness, <>
    <OfflineSessionSlotHost />
    <OfflineSessionSlot deviceId="this-row" sessionId={sessionId} label="Offline" />
  </>, { auth: { id: scope.account } })
  await vi.waitFor(() => expect(harness.container.querySelector('[data-timeline-device]')).not.toBeNull())
  expect(harness.container.querySelector('[data-timeline-device]')?.getAttribute('data-timeline-device')).toBe('this-row')
  expect(harness.container.querySelector('[data-timeline-device]')?.textContent).toBe('2026-11-08T20:07:35Z')
})
