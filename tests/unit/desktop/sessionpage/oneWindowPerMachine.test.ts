// @vitest-environment jsdom
// On the desktop the timeline page (peek) and the session page reach a machine through one session-host window: the
// machine's client (machine-clients), ❌ a second window of the page's own.
import { describe, expect, it, vi } from 'vitest'

const machine = vi.hoisted(() => ({ asked: [] as string[], eventOn: vi.fn(() => () => undefined) }))
vi.mock('@renderer/lib/machine-clients', async (original) => ({
  ...await original<object>(),
  machineClient: (deviceId: string) => { machine.asked.push(deviceId); return { api: { eventOn: machine.eventOn, invoke: vi.fn() }, state: () => 'open' } },
}))
const pipes = vi.hoisted(() => ({ opened: vi.fn() }))
vi.mock('@/lib/remoteSessionHost', async (original) => ({ ...await original<object>(), openPhoneSessionHostPipe: pipes.opened }))
vi.mock('@/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: vi.fn(), eventOn: vi.fn() }) }))

const rpc = await import('@/components/session-watch/sessionpage-rpc')

describe('one session-host window per machine on the desktop', () => {
  it('the timeline page subscribes on the machine\'s own client and opens no window of its own', () => {
    rpc.subscribeSessionEvents('dev-1', 'sub-1', () => undefined)
    expect(machine.asked).toEqual(['dev-1'])
    expect(machine.eventOn).toHaveBeenCalledTimes(1)
    expect(pipes.opened).not.toHaveBeenCalled()
  })
})
