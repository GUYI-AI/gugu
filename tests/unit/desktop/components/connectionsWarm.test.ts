// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionBridge, ConnectionWindow } from '@/lib/connectionBridge'

/** The connections' cold open: the channels are kept within a structural bound; both warm at restore. */
const net = vi.hoisted(() => ({ list: vi.fn(), snapshot: vi.fn(), route: vi.fn() }))
vi.mock('@/lib/chatChannels', () => ({ rendererChatChannelsClient: () => ({ list: net.list }) }))

const { chatChannels, ownerConnections, prefetchConnections } = await import('@/components/connections/connection-replicas')
const { followRendererSession, queryClient } = await import('@/lib/replica')

const OWNER = 'warm-owner'
const channel = (kind: string, accountLabel: string | null) => ({
  kind, accountLabel, agentId: '11000000-0000-4000-8000-000000000001', isDefault: kind === 'wechat', connectedAt: '2026-11-15T10:00:00.000Z',
  health: { state: 'retrying', since: 1_763_200_000_000 }, lastInboundAt: 1_763_200_000_000, lastOutboundAt: 1_763_200_000_000,
})
const kept = () => {
  const block = JSON.parse(localStorage.getItem(`gugu.readModel.v1:${OWNER}`) ?? '{}') as Record<string, { key: unknown[] }>
  return Object.values(block).find((entry) => entry.key[0] === chatChannels.name)
}

beforeEach(() => {
  localStorage.clear()
  followRendererSession('SIGNED_IN', OWNER)
  queryClient.clear()
  vi.clearAllMocks()
  ;(window as ConnectionWindow).__GUGU_CONNECTIONS__ = {
    accountId: () => OWNER, subscribeAccount: () => () => {}, subscribeChanges: () => () => {},
    routing: { read: net.route, peek: () => ({ mode: 'owner', epoch: '4', phase: 'stable', acceptingNewOperations: true }) },
    metadata: () => ({ snapshot: net.snapshot }),
  } as unknown as ConnectionBridge
})

describe('chatChannels across restarts', () => {
  it('every kind connected with 128-character labels: kept, within its 2,048', async () => {
    const kinds = ['wechat', 'feishu', 'dingtalk', 'telegram']
    net.list.mockResolvedValue({ channels: kinds.map((kind) => channel(kind, '名'.repeat(128))), suggestedAgentId: '11000000-0000-4000-8000-000000000002', kinds })
    await chatChannels.fetch()
    const entry = kept()
    expect(entry).toBeDefined()
    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(2048)
  })

  it('a label past the bound: the list is not kept (by definition; ❌ refused, ❌ cut short)', async () => {
    net.list.mockResolvedValue({ channels: [channel('wechat', 'x'.repeat(129))], suggestedAgentId: null, kinds: ['wechat'] })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    await chatChannels.fetch()
    expect(kept()).toBeUndefined()
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('prefetchConnections (at session restore)', () => {
  it('reads the channels and, on the owner route, the owner snapshot for all devices', async () => {
    net.list.mockResolvedValue({ channels: [], suggestedAgentId: null, kinds: ['wechat'] })
    net.route.mockResolvedValue({ mode: 'owner', epoch: '4', phase: 'stable', acceptingNewOperations: true })
    net.snapshot.mockResolvedValue({ version: 1, revision: '1', items: [], application: [] })
    prefetchConnections()
    await vi.waitFor(() => expect(ownerConnections.peek('4', null).state).toBe('value'))
    expect(chatChannels.peek().state).toBe('value')
  })

  it('on the legacy route, no owner snapshot is read', async () => {
    net.list.mockResolvedValue({ channels: [], suggestedAgentId: null, kinds: ['wechat'] })
    net.route.mockResolvedValue({ mode: 'legacy', epoch: '0', phase: 'stable', acceptingNewOperations: true })
    prefetchConnections()
    await vi.waitFor(() => expect(chatChannels.peek().state).toBe('value'))
    await vi.waitFor(() => expect(net.route).toHaveBeenCalled())
    expect(net.snapshot).not.toHaveBeenCalled()
  })
})
