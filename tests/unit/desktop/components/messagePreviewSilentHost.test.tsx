// @vitest-environment jsdom
//
// 2026-11-14 owner:悬停另一台机器上的 agent,卡片只说「Can't reach its activity right now」,看不出是哪台机器、
// 为什么。等不到宿主的第一份推送时,卡片按那台宿主的设备行说清楚:在线 = 没有应答,离线 = 离线。
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { Device } from '@gugu/core/shared/types/chat'

const fixture = vi.hoisted(() => ({ presence: null as null | { deviceOnline: boolean; payload: { deviceId: string } | null } }))
vi.mock('../../../../apps/desktop/src/lib/agentPresenceStore', () => ({ getAgentPresenceSnapshot: () => fixture.presence }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const channel = { on: () => channel }
  return { dataClient: { schema: () => ({ rpc: async () => ({ error: null }) }), channel: () => channel }, chatDb: {} }
})
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  // 频道订上了、请求也发出去了,但宿主一直不推。
  subscribeAuthenticatedRealtimeChannel: (_create: unknown, _key: string, options: { onSubscribed: () => void }) => { options.onSubscribed(); return {} },
  unsubscribeAuthenticatedRealtimeChannel: () => undefined,
}))
vi.mock('../../../../apps/desktop/src/hooks/useShownAgentName', () => ({ useShownAgentName: (value: { name: string } | Array<{ name: string }>) => Array.isArray(value) ? value.map(row => row.name) : value.name }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span>Worker</span> }))
vi.mock('../../../../apps/desktop/src/store/chatContext', async original => ({ ...await original<object>(), useChatStore: () => ({ messages: [], threadMessages: [], identitiesById: {} }) }))

const { MessagePreviewCard } = await import('../../../../apps/desktop/src/components/MessagePreviewCard')
const { DevicesContext } = await import('../../../../apps/desktop/src/store/devicesContext')
const { FIRST_PAYLOAD_TIMEOUT_MS } = await import('../../../../apps/desktop/src/hooks/useAgentMessagePreview')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  h = createReactHarness()
})
afterEach(() => {
  h.cleanup()
  vi.useRealTimers()
})

const labDevice = { device_id: 'device-lab', label: 'lab-box' } as Device
const render = async (devices: Device[]) => {
  await h.render(
    <DevicesContext.Provider value={{ devices, loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [] }}>
      <MessagePreviewCard chatId="group" token={{ id: 'agent', name: 'Worker', avatarUrl: null, avatarSeed: 'worker', stateKey: 'running', toolCount: 0, lastActiveAt: null }} displayName="Worker" open />
    </DevicesContext.Provider>,
  )
  await act(async () => { await vi.advanceTimersByTimeAsync(FIRST_PAYLOAD_TIMEOUT_MS + 1) })
  return h.container.querySelector<HTMLElement>('[data-slot="message-preview"]')!
}

it('names the online host that did not answer', async () => {
  fixture.presence = { deviceOnline: true, payload: { deviceId: 'device-lab' } }
  const card = await render([labDevice])
  expect(card.dataset.previewError).toBe('host_silent')
  expect(card.textContent).toContain('lab-box 没有应答')
})

it('says the host is offline when its device row is offline', async () => {
  fixture.presence = { deviceOnline: false, payload: { deviceId: 'device-lab' } }
  const card = await render([labDevice])
  expect(card.dataset.previewError).toBe('host_offline')
  expect(card.textContent).toContain('lab-box 离线')
})

it("calls a machine outside this account's device list its computer", async () => {
  fixture.presence = { deviceOnline: true, payload: { deviceId: 'device-teammate' } }
  const card = await render([labDevice])
  expect(card.textContent).toContain('它所在的电脑 没有应答')
})

it('keeps the generic text when nothing is known about the host', async () => {
  fixture.presence = null
  const card = await render([labDevice])
  expect(card.dataset.previewError).toBe('host_unreachable')
  expect(card.textContent).toContain('暂时拿不到它的近况')
})
