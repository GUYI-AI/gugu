// @vitest-environment jsdom
// The assistant's small reads as replicas (@@@client-state-model): this computer's calendar (`deviceMeetings`, the reminder
// and its setting share one read), quick chat (`quickChatState`, pushed by main), the rules wait (`assistantRulesState`,
// main pushes the value), and the private chat id (`assistantDm`, never changes once read).
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  available: true,
  invoke: vi.fn(),
  listeners: new Map<string, (value: unknown) => void>(),
  eventOn(channel: string, listener: (value: unknown) => void) { this.listeners.set(channel, listener); return () => { this.listeners.delete(channel) } },
}))
const machine = vi.hoisted(() => ({ invoke: vi.fn() }))
const dm = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => (ipc.available ? ipc : null) }))
vi.mock('@/session/renderer/lib/ipc', () => ({ invokeOnMachine: (...args: unknown[]) => machine.invoke(...args) }))
vi.mock('@/lib/chat', () => ({ chatService: { getOrCreateDM: (...args: unknown[]) => dm.open(...args) } }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }))

const { deviceMeetings } = await import('@/lib/deviceMeetings')
const { assistantRulesState } = await import('@/lib/assistantRulesState')
const { quickChatState } = await import('@/components/assistant/useQuickChatState')
const { assistantDm } = await import('@/lib/assistantDm')
const { followRendererSession, queryClient } = await import('@/lib/replica')
const { QUICK_CHAT_CHANNELS } = await import('@/lib/quickChatIpc')

const SNAPSHOT_PREFIX = 'gugu.readModel.v1:'
const kept = (owner: string, name: string) => Object.values(JSON.parse(localStorage.getItem(SNAPSHOT_PREFIX + owner) ?? '{}') as Record<string, { key: unknown[]; value: unknown }>)
  .find((entry) => entry.key[0] === name)?.value

beforeEach(() => {
  queryClient.clear()
  localStorage.clear()
  followRendererSession('SIGNED_IN', 'owner')
  ipc.available = true
  ipc.invoke.mockReset()
  machine.invoke.mockReset()
  dm.open.mockReset()
})

describe('deviceMeetings', () => {
  it('a calendar read is "ok" with its meetings', async () => {
    const meetings = [{ id: 'm', title: 'Standup', start: '2026-11-15T10:00:00Z', end: null, allDay: false }]
    machine.invoke.mockResolvedValue({ ok: true, meetings })
    await expect(deviceMeetings.fetch()).resolves.toEqual({ status: 'ok', meetings })
  })

  it('no calendar here is a value ("missing"); any other failure is a failed read (❌ taken for connected)', async () => {
    machine.invoke.mockResolvedValue({ ok: false, code: 'not_granted' })
    await expect(deviceMeetings.fetch()).resolves.toEqual({ status: 'missing' })
    await deviceMeetings.refresh()
    machine.invoke.mockResolvedValue({ ok: false, code: 'timeout' })
    await expect(deviceMeetings.fetch()).rejects.toThrow('timeout')
  })
})

describe('assistantRulesState', () => {
  it('reads main once; a phone or a web page truly does not wait', async () => {
    ipc.invoke.mockResolvedValue({ pending: true, stuck: false })
    await expect(assistantRulesState.fetch()).resolves.toEqual({ pending: true, stuck: false })
    await assistantRulesState.fetch()
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    queryClient.clear()
    ipc.available = false
    await expect(assistantRulesState.fetch()).resolves.toEqual({ pending: false, stuck: false })
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
  })

  it("is the signed-in account's: after A signs out and B signs in, A's wait is not shown (account scan)", async () => {
    ipc.invoke.mockResolvedValue({ pending: true, stuck: false })
    followRendererSession('SIGNED_IN', 'owner-a')
    await assistantRulesState.fetch()
    followRendererSession('SIGNED_OUT', null)
    followRendererSession('SIGNED_IN', 'owner-b')
    expect(assistantRulesState.peek()).toEqual({ state: 'unknown' })
  })
})

describe('quickChatState', () => {
  it('reads main once (pushed afterwards) and is kept across restarts', async () => {
    const state = { supported: true, enabled: true, registered: true, accelerator: 'Alt+Space' }
    ipc.invoke.mockResolvedValue(state)
    await expect(quickChatState.fetch()).resolves.toEqual(state)
    await quickChatState.fetch()
    expect(ipc.invoke).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.state)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    expect(kept('device', 'quickChatState')).toEqual(state)
  })
})

describe('assistantDm', () => {
  it('opens the private chat once per assistant (a chat id never changes) and keeps it across restarts', async () => {
    dm.open.mockResolvedValue('chat-1')
    await expect(assistantDm.fetch('agent-1')).resolves.toBe('chat-1')
    await assistantDm.fetch('agent-1')
    expect(dm.open).toHaveBeenCalledTimes(1)
    expect(dm.open).toHaveBeenCalledWith('owner', 'agent-1')
    expect(kept('owner', 'assistantDm')).toBe('chat-1')
  })

  it('a failed open is a failed read (the shell says it and offers a retry)', async () => {
    dm.open.mockRejectedValue(new Error('rpc down'))
    await expect(assistantDm.fetch('agent-2')).rejects.toThrow('rpc down')
    expect(assistantDm.peek('agent-2').state).toBe('error')
  })
})
