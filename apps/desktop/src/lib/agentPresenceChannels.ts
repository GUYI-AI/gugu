import { useEffect, useMemo, useRef } from 'react'
import { dataClient } from './supabase'
import { subscribeAuthenticatedRealtimeChannel, unsubscribeAuthenticatedRealtimeChannel } from './realtimeChannel'
import { applyAgentPresenceBroadcast, coverAgentPresence, holdAgentPresenceChannel, releaseAgentPresenceChannel, uncoverAgentPresence } from './agentPresenceStore'
import { rendererLogger } from './log'

const log = rendererLogger('agent-presence')

// The two places agent status is delivered to (identity.publish_agent_presence). Each is a permission boundary, checked
// by the server once when joining: every agent of mine; the agents of a chat I am a member of.
export const ownerPresenceChannel = (userId: string) => `presence:owner:${userId}`
export const chatPresenceChannel = (chatId: string) => `presence:chat:${chatId}`

// One subscription per channel name, however many surfaces hold it (a chat open on the chats tab and as a session-page
// block): a second join of the same topic would collide with the first. Its agents are the union of its holders'.
type Holding = { holders: Map<object, readonly string[]>; close: () => void }
const holdings = new Map<string, Holding>()

const scopeOf = (holding: Holding) => [...new Set([...holding.holders.values()].flat())]

function hold(channel: string, holder: object, agentUserIds: readonly string[]): void {
  const existing = holdings.get(channel)
  const holding = existing ?? { holders: new Map(), close: () => undefined }
  holding.holders.set(holder, agentUserIds)
  holdAgentPresenceChannel(channel, scopeOf(holding))
  if (existing) return
  holdings.set(channel, holding)
  holding.close = open(channel)
}

function release(channel: string, holder: object): void {
  const holding = holdings.get(channel)
  if (!holding?.holders.delete(holder)) return
  if (holding.holders.size > 0) {
    holdAgentPresenceChannel(channel, scopeOf(holding))
    return
  }
  holdings.delete(channel)
  holding.close()
}

function open(channel: string): () => void {
  const handle = subscribeAuthenticatedRealtimeChannel(() => dataClient.channel(channel, {
    config: { private: true, broadcast: { self: false } },
  }).on('broadcast', { event: 'agent_presence' }, ({ payload }) => {
    try {
      applyAgentPresenceBroadcast(channel, payload)
    } catch (error) {
      log.error({ error, channel }, 'Dropped a malformed agent presence broadcast')
    }
  }), channel, {
    reconnectWhenIdle: false,
    onSubscribed: () => coverAgentPresence(channel),
    onStatus: (status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') uncoverAgentPresence(channel)
    },
  })
  return () => {
    releaseAgentPresenceChannel(channel)
    void unsubscribeAuthenticatedRealtimeChannel(handle)
  }
}

/**
 * Hold one presence channel while the caller passes it. `agentUserIds` are the agents the caller knows to be in its
 * scope: they are read once each time the channel subscribes (first time and after every reconnect), so the cache is
 * current from then on; broadcasts keep it so. A channel that drops out (error, timeout, close) stops vouching for
 * its agents until it subscribes again.
 */
export function useAgentPresenceChannel(channel: string | null, agentUserIds: readonly string[]): void {
  const holder = useRef({}).current
  const idsKey = useMemo(() => [...new Set(agentUserIds.filter(Boolean))].sort().join(','), [agentUserIds])
  useEffect(() => {
    if (channel) hold(channel, holder, idsKey ? idsKey.split(',') : [])
  }, [channel, idsKey, holder])
  useEffect(() => {
    if (!channel) return
    return () => release(channel, holder)
  }, [channel, holder])
}
