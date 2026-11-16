// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@supabase/supabase-js'
import type { ChatChannelList, ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer'
import { createReactHarness } from '../../../support/testHarness'
import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'

/**
 * The WeChat connection reads the `chatChannels` replica itself (❌ an adapter hook): the data boundary is the channels
 * client (`rendererChatChannelsClient().list`). The lists a change answers with are drawn by the panels it hands `apply` to.
 */
const mocks = vi.hoisted(() => ({ owner: 0, list: vi.fn(), client: vi.fn(), apply: null as null | ((next: ChatChannelList) => void), refresh: null as null | (() => Promise<void>) }))
vi.mock('@/lib/chatChannels', () => ({ rendererChatChannelsClient: mocks.client }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) }))
vi.mock('@/components/settings/channels/ChatChannelsPanel', () => ({
  ConnectedChannels: ({ list, apply }: { list: ChatChannelList; apply: (next: ChatChannelList) => void }) => {
    mocks.apply = apply
    return <span data-testid="connected">{list.channels.length}</span>
  },
}))
vi.mock('@/components/settings/channels/WechatConnectDialog', () => ({
  WechatConnectDialog: ({ apply, refresh }: { apply: (next: ChatChannelList) => void; refresh: () => Promise<void> }) => {
    mocks.apply = apply
    mocks.refresh = refresh
    return <span data-testid="dialog" />
  },
}))

import { WechatAppConnection } from '@/components/settings/channels/WechatAppConnection'
import { chatChannels } from '@/components/connections/connection-replicas'
import { assistantPanel } from '@/components/assistant/assistant-panel-replica'
// A panel snapshot changing (the replica the connections watch follows): an assistant's panel entry is written.
const panelChanged = () => assistantPanel.set(['assistant-under-test'], { revision: String(Date.now()) } as never)

const snapshot: ChatChannelList = { channels: [], kinds: ['wechat'], suggestedAgentId: null }
const connected = { ...snapshot, channels: [{ kind: 'wechat', health: { state: 'running' } }] } as unknown as ChatChannelList
let harness: ReturnType<typeof createReactHarness>
const settle = () => act(async () => { await vi.waitFor(() => expect(chatChannels.peek().state).not.toBe('unknown')) })
const hero = () => harness.container.querySelector('[data-testid="app-connection-hero"]')!
const connectButton = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="assistant-connector-connect"]')
const alert = () => harness.container.querySelector('[role="alert"]')
beforeEach(() => {
  vi.clearAllMocks(); mocks.owner += 1; mocks.apply = null; mocks.refresh = null
  publishRendererSession('SIGNED_IN', { user: { id: `channel-owner-${mocks.owner}` }, access_token: 'fixture' } as Session)
  mocks.client.mockReturnValue({ list: mocks.list } as unknown as ChatChannelsClient)
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.useRealTimers(); publishRendererSession('SIGNED_OUT', null) })

describe('channel service failures', () => {
  it('treats a build without a chat client as an absent optional service: nothing to connect, nothing failed', async () => {
    mocks.client.mockReturnValue(null)
    await harness.render(<WechatAppConnection />)
    await settle()
    expect(hero().getAttribute('aria-busy')).toBe('false')
    expect(connectButton()!.disabled).toBe(true)
    expect(alert()).toBeNull()
    expect(mocks.list).not.toHaveBeenCalled()
  })

  it('treats the gateway unconfigured-manager response as absence rather than a channel failure', async () => {
    mocks.list.mockRejectedValueOnce(new CloudComputerError(503, 'not_open', '此环境未配置云电脑管家'))
    await harness.render(<WechatAppConnection />)
    await settle()
    expect(chatChannels.peek()).toMatchObject({ state: 'value', value: { absent: true } })
    expect(connectButton()!.disabled).toBe(true)
    expect(alert()).toBeNull()
  })

  it('is loading (not "not connected") until read; a failure is said and recovers when the user retries', async () => {
    const first = Promise.withResolvers<ChatChannelList>()
    mocks.list.mockReturnValueOnce(first.promise)
    await harness.render(<WechatAppConnection />)
    expect(hero().getAttribute('aria-busy')).toBe('true')
    await act(async () => { first.reject(new CloudComputerError(503, 'unavailable', 'Channel service signing key is not configured.')) })
    await settle()
    expect(alert()).not.toBeNull()
    expect(harness.container.textContent).not.toContain('signing key is not configured')

    mocks.list.mockResolvedValueOnce(snapshot)
    await act(async () => { alert()!.querySelector('button')!.click() })
    await act(async () => { await vi.waitFor(() => expect(alert()).toBeNull()) })
    expect(connectButton()!.disabled).toBe(false)
  })

  it('keeps the list it has and says the failure when a refresh fails', async () => {
    mocks.list.mockResolvedValueOnce(connected)
    await harness.render(<WechatAppConnection />)
    await settle()
    mocks.list.mockRejectedValueOnce(new CloudComputerError(503, 'unavailable', 'Channel service encryption key is not configured.'))
    await act(async () => chatChannels.refresh())
    expect(harness.container.querySelector('[data-testid="connected"]')?.textContent).toBe('1')
    expect(alert()).not.toBeNull()
    expect(harness.container.textContent).not.toContain('encryption key is not configured')
  })
})

describe('what reads the channels again (signal tier)', () => {
  it('the panel-changed signal reads again', async () => {
    mocks.list.mockResolvedValue(snapshot)
    await harness.render(<WechatAppConnection />)
    await settle()
    const reads = mocks.list.mock.calls.length
    await act(async () => { panelChanged() })
    await act(async () => { await vi.waitFor(() => expect(mocks.list.mock.calls.length).toBe(reads + 1)) })
  })

  it('polls every 10 s while shown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
    mocks.list.mockResolvedValue(snapshot)
    await harness.render(<WechatAppConnection />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const reads = mocks.list.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(mocks.list.mock.calls.length).toBe(reads + 1)
  })

  it('a change made here (the `apply` the connect dialog answers with) is what every view shows', async () => {
    mocks.list.mockResolvedValueOnce(snapshot).mockReturnValue(new Promise(() => {}))
    await harness.render(<><WechatAppConnection /><WechatAppConnection /></>)
    await settle()
    await act(async () => { connectButton()!.click() })
    await act(async () => mocks.apply!(connected))
    expect([...harness.container.querySelectorAll('[data-testid="connected"]')].map((node) => node.textContent)).toEqual(['1', '1'])
  })
})

describe('a change answering after the account changed', () => {
  it("lands in the account that asked, ❌ in the next one (the list a disconnect answered for A is never B's)", async () => {
    mocks.list.mockResolvedValueOnce(connected).mockReturnValue(new Promise(() => {}))
    await harness.render(<WechatAppConnection />)
    await settle()
    // The panel's `apply`, as a click handler holds it across its await.
    const applyForA = mocks.apply!
    mocks.owner += 1
    await act(async () => { publishRendererSession('SIGNED_IN', { user: { id: `channel-owner-${mocks.owner}` }, access_token: 'fixture' } as Session) })
    await act(async () => applyForA({ ...connected }))
    expect(chatChannels.peek()).toEqual({ state: 'unknown' })
    expect(harness.container.querySelector('[data-testid="connected"]')).toBeNull()
  })
})
