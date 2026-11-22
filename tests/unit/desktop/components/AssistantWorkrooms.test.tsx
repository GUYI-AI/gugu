// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'

const mocks = vi.hoisted(() => ({
  native: true, rpc: vi.fn(), mobileRpc: vi.fn(), bindings: vi.fn(), warn: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { get agentRuntime() { return mocks.native } } } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => {
  const ipc = { rpcOn: mocks.rpc, events: { on: () => () => {} } };
  // 本机(null)那条线就是 events.on;测试里的文件夹都在本机。
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
})
vi.mock('../../../../apps/desktop/src/components/session-watch/sessionpage-rpc', () => ({ machineRpc: mocks.mobileRpc }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: mocks.warn }) }))

import { useAssistantWorkrooms } from '../../../../apps/desktop/src/components/assistant/useAssistantWorkrooms'
import { removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

/** The home machine's sessions as the session directory lists them (its live list, ❌ the heartbeat digest). */
function listed(sessions: unknown[]) {
  updateDeviceSessions('mac', { projects: [], sessions: sessions as never, cached: false, loading: false, error: null })
}

const shell = {
  assistantState: 'found', assistant: { id: 'assistant' },
  home: { kind: 'computer', deviceId: 'mac', thisDevice: true },
} as AssistantShellSnapshot
function Probe({ snapshot = shell, revision = '' }: { snapshot?: AssistantShellSnapshot; revision?: string }) {
  const rooms = useAssistantWorkrooms(snapshot, revision)
  return <output>{JSON.stringify(rooms)}</output>
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.native = true
  mocks.rpc.mockReset().mockReturnValue({ folders: { listGroupFolders: mocks.bindings } })
  mocks.mobileRpc.mockReset().mockImplementation(() => mocks.rpc())
  mocks.warn.mockReset()
  listed([{ conversationId: 'root', projectId: 'home', agent: { userId: 'assistant' } }])
  mocks.bindings.mockReset().mockResolvedValue([{ id: 'home', chatId: 'workroom' }])
})
afterEach(() => { harness.cleanup(); removeDeviceSessions('mac') })

describe('assistant workroom ownership reads', () => {
  it('reads this computer locally, and does not lose verified ownership on a transient read failure', async () => {
    await renderWithAppProviders(harness, <Probe />)
    expect(mocks.rpc).toHaveBeenCalledWith(null)
    expect(harness.container.textContent).toContain('workroom')
    mocks.bindings.mockRejectedValue(new Error('disconnected'))
    await renderWithAppProviders(harness, <Probe revision="new-membership" />)
    expect(mocks.warn).toHaveBeenCalledOnce()
    expect(harness.container.textContent).toContain('workroom')
  })

  it('ignores a late bindings reply from the previous account and never reuses its rooms for another account', async () => {
    let reply!: (value: unknown) => void
    mocks.bindings.mockReturnValueOnce(new Promise(resolve => { reply = resolve }))
    await renderWithAppProviders(harness, <Probe />)
    const other = { ...shell, assistant: { ...shell.assistant!, id: 'other-assistant' } }
    listed([{ conversationId: 'new-root', projectId: 'new-home', agent: { userId: 'other-assistant' } }])
    mocks.bindings.mockResolvedValue([{ id: 'new-home', chatId: 'new-room' }])
    await renderWithAppProviders(harness, <Probe snapshot={other} />, { auth: { id: 'other-owner' } })
    await act(async () => { reply([{ id: 'home', chatId: 'workroom' }]) })
    expect(harness.container.textContent).toContain('new-room')
    expect(harness.container.textContent).toContain('other-owner')
    expect(harness.container.textContent).not.toContain('workroom')
  })

  it('hides nothing until the home machine\'s list is read (its heartbeat digest is not that list)', async () => {
    updateDeviceSessions('mac', { cached: true })
    await renderWithAppProviders(harness, <Probe />)
    expect(harness.container.textContent).toBe('null')
  })

  it('uses the phone host transport instead of treating the phone as the assistant computer', async () => {
    mocks.native = false
    await renderWithAppProviders(harness, <Probe />)
    expect(mocks.mobileRpc).toHaveBeenCalledWith('mac')
    expect(harness.container.textContent).toContain('workroom')
  })
})
