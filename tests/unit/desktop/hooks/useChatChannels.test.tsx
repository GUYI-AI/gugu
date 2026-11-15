// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import type { ChatChannelList, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer'
import { createReactHarness } from '../../../support/testHarness'
import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'

const mocks = vi.hoisted(() => ({ owner: 0, list: vi.fn(), client: vi.fn() }))
vi.mock('@/lib/chatChannels', () => ({ rendererChatChannelsClient: mocks.client }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }))

import { useChatChannels } from '@/components/settings/channels/useChatChannels'
import { chatChannels } from '@/components/connections/connection-replicas'
import { assistantPanel } from '@/components/assistant/assistant-panel-replica'
// A panel snapshot changing (the replica the connections watch follows): an assistant's panel entry is written.
const panelChanged = () => assistantPanel.set(['assistant-under-test'], { revision: String(Date.now()) } as never)

let state: ReturnType<typeof useChatChannels>
function Probe() {
  state = useChatChannels()
  return <output>{state.status}: {state.error}</output>
}
const snapshot: ChatChannelList = { channels: [], kinds: ['wechat'], suggestedAgentId: null }
let harness: ReturnType<typeof createReactHarness>
const settle = () => act(async () => { await vi.waitFor(() => expect(chatChannels.peek().state).not.toBe('unknown')) })
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner += 1
  publishRendererSession('SIGNED_IN', { user: { id: `channel-owner-${mocks.owner}` }, access_token: 'fixture' } as Session)
  mocks.client.mockReturnValue({ list: mocks.list } as unknown as ChatChannelsClient)
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.useRealTimers(); publishRendererSession('SIGNED_OUT', null) })

describe('channel service failures', () => {
  it('treats a build without a chat client as an absent optional service', async () => {
    mocks.client.mockReturnValue(null)
    await harness.render(<Probe />)
    await settle()
    expect(state.status).toBe('absent')
    expect(state.list).toBeNull()
    expect(state.error).toBe('')
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('treats the gateway unconfigured-manager response as absence rather than a channel failure', async () => {
    mocks.list.mockRejectedValueOnce(new CloudComputerError(503, 'not_open', '此环境未配置云电脑管家'))
    await harness.render(<Probe />)
    await settle()
    expect(state.status).toBe('absent')
    expect(state.error).toBe('')
  })

  it('is loading (not "not connected") until read; a failure is said and recovers when the user retries', async () => {
    const first = Promise.withResolvers<ChatChannelList>()
    mocks.list.mockReturnValueOnce(first.promise)
    await harness.render(<Probe />)
    expect(state.status).toBe('loading')
    await act(async () => { first.reject(new CloudComputerError(503, 'unavailable', 'Channel service signing key is not configured.')) })
    await settle()
    expect(state.status).toBe('failed')
    expect(state.error).toBeTruthy()
    expect(harness.container.textContent).not.toContain('signing key is not configured')

    mocks.list.mockResolvedValueOnce(snapshot)
    await act(async () => state.refresh())
    expect(state.status).toBe('ready')
    expect(state.error).toBe('')
  })

  it('keeps the list it has and says the failure when a refresh fails', async () => {
    mocks.list.mockResolvedValueOnce(snapshot)
    await harness.render(<Probe />)
    await settle()
    mocks.list.mockRejectedValueOnce(new CloudComputerError(503, 'unavailable', 'Channel service encryption key is not configured.'))
    await act(async () => state.refresh())
    expect(state.status).toBe('ready')
    expect(state.list).toEqual(snapshot)
    expect(state.error).toBeTruthy()
    expect(state.error).not.toContain('encryption key is not configured')
  })
})

describe('what reads the channels again (signal tier)', () => {
  it('the panel-changed signal reads again', async () => {
    mocks.list.mockResolvedValue(snapshot)
    await harness.render(<Probe />)
    await settle()
    const reads = mocks.list.mock.calls.length
    await act(async () => { panelChanged() })
    await act(async () => { await vi.waitFor(() => expect(mocks.list.mock.calls.length).toBe(reads + 1)) })
  })

  it('polls every 10 s while shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    mocks.list.mockResolvedValue(snapshot)
    await harness.render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const reads = mocks.list.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.list.mock.calls.length).toBe(reads + 1)
  })

  it('a change made here (`apply`) is what every view shows', async () => {
    mocks.list.mockReturnValue(new Promise(() => {}))
    await harness.render(<Probe />)
    const connected = { ...snapshot, channels: [{ kind: 'wechat' }] } as unknown as ChatChannelList
    await act(async () => state.apply(connected))
    expect(state.list).toBe(connected)
  })
})
