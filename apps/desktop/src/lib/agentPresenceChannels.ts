import { useEffect, useMemo, useRef } from 'react'
import { dataClient } from './supabase'
import { SUBSCRIBE_WATCHDOG_MS as SUBSCRIBE_WAIT_MS, subscribeAuthenticatedRealtimeChannel, unsubscribeAuthenticatedRealtimeChannel, type ManagedRealtimeChannel } from './realtimeChannel'
import { applyAgentPresenceBroadcast, coverAgentPresence, holdAgentPresenceChannel, releaseAgentPresenceChannel, uncoverAgentPresence } from './agentPresenceStore'
import { rendererLogger } from './log'

const log = rendererLogger('agent-presence')

// The two places agent status is delivered to (identity.publish_agent_presence). Each is a permission boundary, checked
// by the server once when joining: every agent of mine; the agents of a chat I am a member of.
export const ownerPresenceChannel = (userId: string) => `presence:owner:${userId}`
export const chatPresenceChannel = (chatId: string) => `presence:chat:${chatId}`

// One subscription per channel name, however many surfaces hold it (a chat open on the chats tab and as a session-page
// block): a second join of the same topic would collide with the first. Its agents are the union of its holders'.
// Let go of, it closes a moment later: React lets go and holds again in adjacent commits (switching back to a chat, a
// panel hidden while a block of the same chat shows, StrictMode), and a topic re-joined before its leave finished
// lands on the leaving channel (realtimeChannel.ts unsubscribeAuthenticatedRealtimeChannel). A reopen still waits for
// that leave.
const CLOSE_DELAY_MS = 1000
type Holding = {
  holders: Map<object, readonly string[]>
  channel: ManagedRealtimeChannel | null
  closing: ReturnType<typeof setTimeout> | null
  /** Until it first subscribes. */
  waiting: ReturnType<typeof setTimeout> | null
}
const holdings = new Map<string, Holding>()
const leaving = new Map<string, Promise<void>>()

const scopeOf = (holding: Holding) => [...new Set([...holding.holders.values()].flat())]

function hold(channel: string, holder: object, agentUserIds: readonly string[]): void {
  const existing = holdings.get(channel)
  const holding: Holding = existing ?? { holders: new Map(), channel: null, closing: null, waiting: null }
  if (holding.closing) clearTimeout(holding.closing)
  holding.closing = null
  holding.holders.set(holder, agentUserIds)
  holdAgentPresenceChannel(channel, scopeOf(holding))
  if (existing) return
  holdings.set(channel, holding)
  void (leaving.get(channel) ?? Promise.resolve()).then(() => {
    if (holdings.get(channel) === holding) holding.channel = open(channel, holding)
  })
}

function release(channel: string, holder: object): void {
  const holding = holdings.get(channel)
  if (!holding?.holders.delete(holder)) return
  if (holding.holders.size > 0) {
    holdAgentPresenceChannel(channel, scopeOf(holding))
    return
  }
  holding.closing = setTimeout(() => close(channel, holding), CLOSE_DELAY_MS)
}

function close(channel: string, holding: Holding): void {
  if (holdings.get(channel) !== holding) return
  holdings.delete(channel)
  if (holding.waiting) clearTimeout(holding.waiting)
  releaseAgentPresenceChannel(channel)
  if (!holding.channel) return
  const left = unsubscribeAuthenticatedRealtimeChannel(holding.channel)
  leaving.set(channel, left)
  void left.finally(() => { if (leaving.get(channel) === left) leaving.delete(channel) })
}

function open(channel: string, holding: Holding): ManagedRealtimeChannel {
  // Not subscribed in time (realtime auth failing reports no status; a stalled join is retried silently): the channel
  // counts as down, so its agents are read once instead of waiting for it. A later subscribe covers them again.
  holding.waiting = setTimeout(() => uncoverAgentPresence(channel), SUBSCRIBE_WAIT_MS)
  return subscribeAuthenticatedRealtimeChannel(() => dataClient.channel(channel, {
    config: { private: true, broadcast: { self: false } },
  }).on('broadcast', { event: 'agent_presence' }, ({ payload }) => {
    try {
      applyAgentPresenceBroadcast(channel, payload)
    } catch (error) {
      log.error({ error, channel }, 'Dropped a malformed agent presence broadcast')
    }
  }), channel, {
    reconnectWhenIdle: false,
    onSubscribed: () => {
      if (holding.waiting) clearTimeout(holding.waiting)
      holding.waiting = null
      coverAgentPresence(channel)
    },
    onStatus: (status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') uncoverAgentPresence(channel)
    },
  })
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
