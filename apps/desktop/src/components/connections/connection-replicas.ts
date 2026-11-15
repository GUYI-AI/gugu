import { isCloudComputerNotOpen } from '@gugu/core/cloud/cloudComputer'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import { ConnectionError } from '@gugu/core/cloud/connections'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { connectionBridge, connectionRoute } from '@/lib/connectionBridge'
import { replica, useReplica, type Reading } from '@/lib/replica'
import { subscribeAssistantPanels } from '@/components/assistant/assistant-panel-replica'
import { isTooOld, libraryHostOf, peekLibraryHost } from '@/session/renderer/features/library/library-host'
import { peekAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations'
import type { rpc } from '@/session/renderer/lib/ipc'
import type { ConnectionMetadataSnapshot, ConnectionMetadataStore } from './connection-metadata'
import { connectionNeedsConfirmation } from './connection-application-status'
import { connectionReadDelay } from './connection-read-policy'
import { CONNECTIONS_CHANGED } from './owner-connection-metadata'

/**
 * @@@connection-replicas — the connections library's data (@@@client-state-model, PR 3), one replica per kind:
 * - `ownerConnections(epoch, deviceId)`: the owner's connection metadata (service snapshot), what the owner-connection
 *   store reads and writes (connection-host.ts); every owner-mode surface derives from it (statuses, configured, a
 *   provider's accounts). Replaces the assistant panel cache's `owner-connections.v1:*` account rows.
 * - `chatChannels()`: the WeChat (chat channel) list. Replaces the panel cache's `application-connections:wechat` row.
 * - `integrationsCatalog / integrationStatuses / configuredConnections / integrationAccounts / integrationAccountChecks`
 *   keyed by a library host key (`libraryHostOf`): the hosts that are not owner-mode (this machine's own integrations,
 *   another machine's, a legacy assistant panel).
 * Signal tier: `CONNECTIONS_CHANGED` / an assistant panel snapshot changing (this window's announcements, and the owner's change bus
 * through the store's `invalidate`) refresh them (`watchConnections`); focus too. The owner's rows and the channels are
 * account scope (a switch drops them); the host-keyed ones are device scope like the machine they ask (this machine's
 * integrations are asked signed in or not), and a host bound to an account carries its owner in its key. None is kept
 * across restarts (they grow with the account and are not in the cap table).
 */

/** No cloud computer: the channels live there, so there are none to list — an answer, not a failure. */
export type ChatChannelsValue = ChatChannelList | { absent: true }

export const chatChannels = replica({
  name: 'chatChannels',
  scope: 'account',
  read: async (_owner: string): Promise<ChatChannelsValue> => {
    const client = rendererChatChannelsClient()
    if (!client) return { absent: true }
    try {
      return await client.list()
    } catch (error) {
      if (isCloudComputerNotOpen(error)) return { absent: true }
      throw error
    }
  },
  refreshOnFocus: true,
  // The channel's health moves on the cloud computer (starting → running, a login lapsing); nothing pushes it here.
  refreshEvery: 10_000,
  // Kept for the WeChat row's and the connections page's first frame. Bounded by construction: one channel per kind
  // (`ChatChannelKind`, 4) of fixed fields (kind, agent id, flags, ISO date, health, two times ≈ 260) plus the account
  // label; with every label ≤ 128 that is ≤ 4 × 388 + the list's fields and the entry ≈ 300 = 1,852 ≤ 2,048. A list
  // outside that bound (a longer label, a kind this build does not know) is not kept, by definition (❌ refused, ❌ cut).
  persist: { maxBytes: 2048, maxEntries: 1, carry: (value: ChatChannelsValue) => (fitsKept(value) ? value : undefined) },
})

/** Whether a channel list is within the bound the snapshot keeps (see `chatChannels.persist`). */
function fitsKept(value: ChatChannelsValue): boolean {
  if ('absent' in value) return true
  return value.channels.length <= CHAT_CHANNEL_KINDS && value.kinds.length <= CHAT_CHANNEL_KINDS
    && value.channels.every((channel) => (channel.accountLabel ?? '').length <= 128)
}
const CHAT_CHANNEL_KINDS = 4

/** The route epoch a key was read under is still the owner's route now (else the key is stale: refused). */
function ownerRoute(epoch: string) {
  const route = connectionBridge().routing.peek()
  if (route?.mode !== 'owner' || route.epoch !== epoch) throw new ConnectionError('route-changed', 'CONNECTION_ROUTE_CHANGED')
  return route
}

export const ownerConnections = replica({
  name: 'ownerConnections',
  scope: 'account',
  // The owner-connection store reads (and keeps the newer revision); it puts what it read here (connection-host.ts).
  read: (owner: string, epoch: string, deviceId: string | null): Promise<ConnectionMetadataSnapshot> =>
    connectionBridge().metadata(owner, deviceId, ownerRoute(epoch)).snapshot(),
  // Signal-fed and polled: a confirmation under way is asked about every 3 s, else every 15 s.
  fresh: Infinity,
  refreshOnFocus: true,
  refreshEvery: (value) => (value?.application.some(connectionNeedsConfirmation) ? 3_000 : 15_000),
  // A failed read is retried with backoff and said meanwhile (the reading's `error`); after 3 the reading is an error
  // (the page says so once, useConnectionReadNotice) and the poll keeps asking. The kept value stays.
  retry: 3,
  retryDelay: connectionReadDelay,
})

/**
 * Warm the connections after the session is restored (signed in, or the shell starting signed in), as the assistant
 * panel is: a page opened later draws its first frame from the value. The channels (also kept across restarts) and,
 * when the route is the owner's, its snapshot for all devices (the connections page's store). A failure is the
 * reading's (said where shown), not here.
 */
export function prefetchConnections(): void {
  void chatChannels.prefetch()
  void connectionRoute.fetch().then((route) => {
    if (route.mode === 'owner') void ownerConnections.prefetch(route.epoch, null)
  }, () => {})
}

/** The owner snapshot an owner-connection store (its route epoch and device) reads into; unknown for any other store. */
export function useOwnerConnectionsReading(store: ConnectionMetadataStore | undefined): Reading<ConnectionMetadataSnapshot> {
  return useReplica(ownerConnections, store?.authorityEpoch && !store.assistantId ? [store.authorityEpoch, store.deviceId ?? null] : null)
}

/** A host that is not owner-mode, read through its key; `local` copy: what its legacy panel has in hand. */
type IntegrationsRpc = typeof rpc.integrations
type IntegrationList = Awaited<ReturnType<IntegrationsRpc['list']>>
type ConnectionStatuses = Awaited<ReturnType<IntegrationsRpc['checkAllConnections']>>
type ConfiguredConnections = Awaited<ReturnType<IntegrationsRpc['checkConfiguredConnections']>>
export type IntegrationAccounts =
  | { supported: true; accounts: Awaited<ReturnType<IntegrationsRpc['accounts']>> }
  /** The host is older than accounts per provider (#7240): the detail draws one account. */
  | { supported: false }

const legacyPanelView = (hostKey: string, locale: string) => {
  const host = peekLibraryHost(hostKey)
  return host?.assistantPanel ? peekAssistantPanelIntegrations(host.assistantPanel, locale) : undefined
}

export const integrationsCatalog = replica({
  name: 'integrationsCatalog',
  scope: 'device',
  read: (_owner: string, hostKey: string, locale: string): Promise<IntegrationList> => libraryHostOf(hostKey).integrations.list(locale),
  // A host's catalog changes with its build or its panel's publication: both signal.
  fresh: Infinity,
  retry: 2,
  retryDelay: connectionReadDelay,
  local: (_owner, hostKey, locale) => legacyPanelView(hostKey, locale)?.items as IntegrationList | undefined,
})

export const integrationStatuses = replica({
  name: 'integrationStatuses',
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<ConnectionStatuses> => libraryHostOf(hostKey).integrations.checkAllConnections(),
  fresh: 30_000,
  refreshOnFocus: true,
  retry: 2,
  retryDelay: connectionReadDelay,
  local: (_owner, hostKey) => legacyPanelView(hostKey, 'en-US')?.statuses as ConnectionStatuses | undefined,
})

export const configuredConnections = replica({
  name: 'configuredConnections',
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<ConfiguredConnections> => libraryHostOf(hostKey).integrations.checkConfiguredConnections(),
  fresh: Infinity,
  retry: 2,
  retryDelay: connectionReadDelay,
  local: (_owner, hostKey) => legacyPanelView(hostKey, 'en-US')?.configured as ConfiguredConnections | undefined,
})

export const integrationAccounts = replica({
  name: 'integrationAccounts',
  scope: 'device',
  read: async (_owner: string, hostKey: string, integrationId: string): Promise<IntegrationAccounts> => {
    try {
      return { supported: true, accounts: await libraryHostOf(hostKey).integrations.accounts(integrationId) }
    } catch (error) {
      if (isTooOld(error)) return { supported: false }
      throw error
    }
  },
  fresh: 30_000,
  refreshOnFocus: true,
})

export const integrationAccountChecks = replica({
  name: 'integrationAccountChecks',
  scope: 'device',
  read: (_owner: string, hostKey: string, integrationId: string) => libraryHostOf(hostKey).integrations.checkAccounts(integrationId),
  fresh: 30_000,
  refreshOnFocus: true,
})

/** What a connection change (made here or heard from the owner's bus) reads again: every model above. */
export function refreshConnections(): void {
  void chatChannels.refresh()
  void ownerConnections.refresh()
  void integrationsCatalog.refresh()
  void integrationStatuses.refresh()
  void configuredConnections.refresh()
  void integrationAccounts.refresh()
  void integrationAccountChecks.refresh()
}

/** One host's statuses changed (a connect, a disconnect, an authorization settled): its statuses and accounts again. */
export function refreshConnectionStatuses(hostKey: string): void {
  void integrationStatuses.refresh(hostKey)
  void configuredConnections.refresh(hostKey)
  void integrationAccounts.refresh(hostKey)
  void integrationAccountChecks.refresh(hostKey)
}

let watchers = 0
let stopPanels: (() => void) | null = null
/**
 * The window's connection signals, while any surface shows connections (ref-counted, module level): each announcement
 * reads the shown models again. A watcher starting with values already there reads once (changes nobody heard).
 */
export function watchConnections(): () => void {
  if (watchers++ === 0) {
    window.addEventListener(CONNECTIONS_CHANGED, refreshConnections)
    stopPanels = subscribeAssistantPanels(refreshConnections)
    if (chatChannels.peek().state === 'value') refreshConnections()
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--watchers > 0) return
    window.removeEventListener(CONNECTIONS_CHANGED, refreshConnections)
    stopPanels?.()
    stopPanels = null
  }
}
