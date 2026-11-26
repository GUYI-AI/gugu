import { expect, it, vi } from 'vitest'
import { createChatChannelsClient, type ChatChannel, type ChatChannelList } from '@gugu/core/cloud/chatChannels'
import { assistantChatChannelItems, createAssistantChatChannelReader, ASSISTANT_CHAT_CHANNEL_TIMEOUT_MS } from '../../../apps/desktop/electron/sessionpage/assistant-chat-channel-index'
import { assistantLocalIndex } from '../../../apps/desktop/electron/sessionpage/assistant-local-index'
import { assistantStartupIndex } from '../../../apps/desktop/electron/sessionpage/assistant-startup-index'
import { ASSISTANT_INDEX_LIMIT, boundedAssistantIndex } from '../../../apps/desktop/electron/sessionpage/assistant-index-format'

const channel = (patch: Partial<ChatChannel> = {}): ChatChannel => ({
  kind: 'wechat', accountLabel: 'PRIVATE-ACCOUNT', agentId: 'this-assistant', isDefault: true,
  connectedAt: '2026-11-25T00:00:00.000Z', health: { state: 'running' },
  lastInboundAt: null, lastOutboundAt: null, ...patch,
})
const list = (channels: ChatChannel[]): ChatChannelList => ({ channels, suggestedAgentId: 'PRIVATE-ID', kinds: ['wechat'] })

it('exposes connected channels separately from tool availability without account or message bodies', async () => {
  const items = await assistantChatChannelItems(async () => list([channel()]), 'this-assistant')
  expect(items).toEqual([expect.objectContaining({ id: 'wechat', name: 'WeChat / 微信', isDefault: true })])
  expect(JSON.parse(items[0]!.note!)).toEqual({ kind: 'wechat', health: 'running', bound_to_this_assistant: true, bound_to_other_agent: false })
  expect(JSON.stringify(items)).not.toContain('PRIVATE-')
  expect(JSON.stringify(items)).not.toContain('this-assistant')
})

it('keeps paused and other-agent bindings visible without claiming that they can send', async () => {
  const items = await assistantChatChannelItems(async () => list([channel({ agentId: 'other', health: { state: 'paused', until: 123 } })]), 'this-assistant')
  expect(JSON.parse(items[0]!.note!)).toMatchObject({ health: 'paused', bound_to_this_assistant: false, bound_to_other_agent: true })
})

it('distinguishes an empty successful inventory from a failed or malformed read', async () => {
  expect(await assistantChatChannelItems(async () => list([]), 'this-assistant')).toEqual([])
  await expect(assistantChatChannelItems(async () => { throw new Error('PRIVATE-auth') }, 'this-assistant')).rejects.toThrow()
  await expect(assistantChatChannelItems(async () => ({ channels: null }) as unknown as ChatChannelList, 'this-assistant')).rejects.toThrow()
})

it('reports failed channel discovery as unavailable and preserves the real reread pointer', async () => {
  const rows = await assistantLocalIndex('/no-fixture', 'computer', '/no-fixture', async () => [], async () => { throw new Error('PRIVATE-auth') })
  const source = rows.find(row => row.source === 'chat_channels')!
  expect(source.status).toBe('unavailable')
  expect(source.items).toBeUndefined()
  expect(source.read).toContain('gugu://assistant/resources')
  expect(source.read).toContain('定时')
  expect(JSON.stringify(rows)).not.toContain('PRIVATE-auth')
})

it('carries channels through the startup hook shared by ordinary and scheduled turns', async () => {
  const items = await assistantChatChannelItems(async () => list([channel()]), 'this-assistant')
  const result = await assistantStartupIndex({ accountId: async () => 'owner',
    run: async action => action.action === 'device_actions' ? { devices: [] } : action.action === 'schedule_list' ? { schedules: [] } : [],
    localSources: async () => [{ source: 'chat_channels', status: 'read', items, read: 'gugu://assistant/resources' }],
  })
  expect(result).toContain('"source":"chat_channels"')
  expect(result).toContain('wechat')
  expect(result).not.toContain('PRIVATE-')
})

it('never delivers the previous account channel inventory after a sign-in change', async () => {
  let owner = 'first'
  await expect(assistantStartupIndex({ accountId: async () => owner,
    run: async action => action.action === 'device_actions' ? { devices: [] } : action.action === 'schedule_list' ? { schedules: [] } : [],
    localSources: async () => { owner = 'second'; return [{ source: 'chat_channels', status: 'read', items: [], read: 'gugu://assistant/resources' }] },
  })).rejects.toThrow('account changed')
})

it('preserves channel routing metadata when large project inventories exceed the context budget', () => {
  const result = boundedAssistantIndex(['<gugu_resource_index>', JSON.stringify({ account: 'owner' }),
    JSON.stringify({ source: 'chat_channels', status: 'read', items: [{ id: 'wechat', name: 'WeChat', note: 'bound to this assistant' }], read: 'gugu://assistant/resources' }),
    JSON.stringify({ source: 'projects', items: Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: 'project'.repeat(50) })) }), '</gugu_resource_index>'])
  expect(result.length).toBeLessThanOrEqual(ASSISTANT_INDEX_LIMIT)
  expect(result).toContain('wechat')
  expect(result).toContain('bound to this assistant')
  expect(result).toContain('omitted_items')
})

it('coalesces concurrent resource reads and reuses metadata for fifteen seconds', async () => {
  let now = 0
  const load = vi.fn(async () => list([channel()]))
  const read = createAssistantChatChannelReader({ expectedOwner: 'owner', accountId: async () => 'owner', assistantAgentId: 'this-assistant', list: load, now: () => now })
  await Promise.all([read(), read()])
  now = 14_999; await read()
  expect(load).toHaveBeenCalledTimes(1)
  now = 15_000; await read()
  expect(load).toHaveBeenCalledTimes(2)
})

it('does not turn cached request failures into successful empty channel lists', async () => {
  let now = 0
  const load = vi.fn(async () => { throw new Error('read unavailable') })
  const read = createAssistantChatChannelReader({ expectedOwner: 'owner', accountId: async () => 'owner', assistantAgentId: 'this-assistant', list: load, now: () => now })
  await expect(read()).rejects.toThrow('read unavailable')
  await expect(read()).rejects.toThrow('read unavailable')
  expect(load).toHaveBeenCalledTimes(1)
  now = 15_000
  await expect(read()).rejects.toThrow('read unavailable')
  expect(load).toHaveBeenCalledTimes(2)
})

it('drops cached metadata on account changes and checks in-flight replies again', async () => {
  let owner = 'owner'
  const load = vi.fn(async () => list([channel()]))
  const read = createAssistantChatChannelReader({ expectedOwner: 'owner', accountId: async () => owner, assistantAgentId: 'this-assistant', list: load })
  await read(); owner = 'other'
  await expect(read()).rejects.toThrow('owner changed')
  owner = 'owner'; await read()
  expect(load).toHaveBeenCalledTimes(2)
  const delayed = createAssistantChatChannelReader({ expectedOwner: 'owner', accountId: async () => owner, assistantAgentId: 'this-assistant', list: async () => { owner = 'other'; return list([channel()]) } })
  await expect(delayed()).rejects.toThrow('owner changed')
})

it('bounds the whole cold read even when token lookup never answers', async () => {
  const fetch = vi.fn(async (): Promise<Response> => { throw new Error('must not reach fetch') })
  const client = createChatChannelsClient({ baseUrl: 'http://127.0.0.1:1', accessToken: () => new Promise<string>(() => undefined), fetch,
    requestTimeoutMs: ASSISTANT_CHAT_CHANNEL_TIMEOUT_MS })
  let signal: AbortSignal | undefined
  const read = createAssistantChatChannelReader({ expectedOwner: 'owner', accountId: async () => 'owner', assistantAgentId: 'this-assistant',
    list: current => { signal = current; return client.list(current) } })
  const started = Date.now()
  await expect(read()).rejects.toThrow('metadata read timed out')
  expect(Date.now() - started).toBeGreaterThanOrEqual(ASSISTANT_CHAT_CHANNEL_TIMEOUT_MS - 50)
  expect(signal?.aborted).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})
