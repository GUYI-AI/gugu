import { useEffect, useMemo } from 'react'
import { dataClient } from './supabase'
import { subscribeAuthenticatedRealtimeChannel, unsubscribeAuthenticatedRealtimeChannel } from './realtimeChannel'
import { applyAgentPresenceBroadcast, coverAgentPresence, extendAgentPresenceCoverage, uncoverAgentPresence } from './agentPresenceStore'
import { rendererLogger } from './log'

const log = rendererLogger('agent-presence')

// The two places agent status is delivered to (identity.publish_agent_presence). Each is a permission boundary, checked
// by the server once when joining: every agent of mine; the agents of a chat I am a member of.
export const ownerPresenceChannel = (userId: string) => `presence:owner:${userId}`
export const chatPresenceChannel = (chatId: string) => `presence:chat:${chatId}`

const scopes = new Map<string, readonly string[]>()

/**
 * Subscribe one presence channel while the caller holds it. `agentUserIds` are the agents the caller knows to be in its
 * scope: they are read once each time the channel subscribes (first time and after every reconnect), so the cache is
 * current from then on; broadcasts keep it so. A channel that drops out (error, timeout, close) stops vouching for
 * its agents until it subscribes again.
 */
export function useAgentPresenceChannel(channel: string | null, agentUserIds: readonly string[]): void {
  const idsKey = useMemo(() => [...new Set(agentUserIds.filter(Boolean))].sort().join(','), [agentUserIds])
  useEffect(() => {
    if (!channel) return
    scopes.set(channel, idsKey ? idsKey.split(',') : [])
    extendAgentPresenceCoverage(channel, scopes.get(channel)!)
  }, [channel, idsKey])
  useEffect(() => {
    if (!channel) return
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
      onSubscribed: () => coverAgentPresence(channel, scopes.get(channel) ?? []),
      onStatus: (status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') uncoverAgentPresence(channel)
      },
    })
    return () => {
      uncoverAgentPresence(channel)
      scopes.delete(channel)
      void unsubscribeAuthenticatedRealtimeChannel(handle)
    }
  }, [channel])
}
