// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionBridge, ConnectionWindow } from '@/lib/connectionBridge'

/** The connections' cold open: the channels are kept within a structural bound; both warm at restore. */
const net = vi.hoisted(() => ({ list: vi.fn(), snapshot: vi.fn(), route: vi.fn() }))
vi.mock('@/lib/chatChannels', () => ({ rendererChatChannelsClient: () => ({ list: net.list }) }))

const { chatChannels, ownerConnections, prefetchConnections } = await import('@/components/connections/connection-replicas')
const { followRendererSession, queryClient } = await import('@/lib/replica')

const OWNER = 'warm-owner'
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
