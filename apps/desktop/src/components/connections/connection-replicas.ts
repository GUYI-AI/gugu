import { isAssistantPanelReadRetryable, retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead'
import { isCloudComputerNotOpen } from '@gugu/core/cloud/cloudComputer'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import { ConnectionError } from '@gugu/core/cloud/connections'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { connectionBridge, connectionRoute } from '@/lib/connectionBridge'
import { replica, useReplica, type Reading } from '@/lib/replica'
import { onAssistantPanelChanged } from '@/components/assistant/assistant-panel-replica'
import { isTooOld, libraryHostOf, peekLibraryHost } from '@/session/renderer/features/library/library-host'
import { peekAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations'
import type { rpc } from '@/session/renderer/lib/ipc'
import type { ConnectionMetadataSnapshot, ConnectionMetadataStore } from './connection-metadata'
import { connectionNeedsConfirmation } from './connection-application-status'
import { connectionReadDelay } from './connection-read-policy'
import { CONNECTIONS_CHANGED } from './owner-connection-metadata'

/**
 * @@@connection-replicas — the connections library's data (@@@client-state-model): the owner's connection snapshot
 * (`ownerConnections`, owner mode), the chat channels, and per library host key (`libraryHostOf`, not owner mode) the
 * integrations' catalog, statuses and accounts. Signal tier: `CONNECTIONS_CHANGED` and assistant panel changes refresh
 * them (`watchConnections`), focus too. Host-keyed ones are device scope (a host bound to an account carries its owner).
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
  // Bound: ≤ 4 kinds × (fixed fields ≈ 260 + label ≤ 128) + ≈ 300 = 1,852 ≤ 2,048; a list outside it is not kept (❌ cut).
  persist: { maxBytes: 2048, maxEntries: 1, carry: (value: ChatChannelsValue) => (fitsKept(value) ? value : undefined) },
})

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
  read: (owner: string, epoch: string, deviceId: string | null): Promise<ConnectionMetadataSnapshot> =>
    connectionBridge().metadata(owner, deviceId, ownerRoute(epoch)).snapshot(),
  // Signal-fed and polled: a confirmation under way is asked about every 3 s, else every 15 s.
  fresh: Infinity,
  refreshOnFocus: true,
  refreshEvery: (value) => (value?.application.some(connectionNeedsConfirmation) ? 3_000 : 15_000),
  // After 3 failed retries the reading is an error (said once, useConnectionReadNotice); the poll keeps asking.
  retry: 3,
  retryDelay: connectionReadDelay,
})

/** Warm the channels and (owner route) the owner snapshot after the session is restored; a failure is the reading's. */
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

type IntegrationsRpc = typeof rpc.integrations
type IntegrationList = Awaited<ReturnType<IntegrationsRpc['list']>>
type ConnectionStatuses = Awaited<ReturnType<IntegrationsRpc['checkAllConnections']>>
type ConfiguredConnections = Awaited<ReturnType<IntegrationsRpc['checkConfiguredConnections']>>
export type IntegrationAccounts =
  | { supported: true; accounts: Awaited<ReturnType<IntegrationsRpc['accounts']>> }
  /** The host is older than accounts per provider (#7240): the detail draws one account. */
  | { supported: false }

/**
 * How a host's connection reads are asked again (as before PR 3): a host behind the assistant panel retries a failure that
 * may pass (its computer waking) twice and, while it fails so, asks again every 30 s; a fixed fact (unprepared, signed out…)
 * fails at once. This desktop's own IPC and another machine are not retried (an offline machine would only hang).
 */
const panelHost = (hostKey: string) => !!peekLibraryHost(hostKey)?.assistantPanelExpected
const hostRetry = (failures: number, error: Error, hostKey: string) => panelHost(hostKey) && retryAssistantPanelRead(failures, error)
const hostRecheck = (_value: unknown, error: Error | null, hostKey: string) =>
  error && panelHost(hostKey) && isAssistantPanelReadRetryable(error) ? 30_000 : false
const hostReadPolicy = { retry: hostRetry, retryDelay: connectionReadDelay, refreshEvery: hostRecheck }

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
  ...hostReadPolicy,
  local: (_owner, hostKey, locale) => legacyPanelView(hostKey, locale)?.items as IntegrationList | undefined,
})

export const integrationStatuses = replica({
  name: 'integrationStatuses',
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<ConnectionStatuses> => libraryHostOf(hostKey).integrations.checkAllConnections(),
  fresh: 30_000,
  refreshOnFocus: true,
  ...hostReadPolicy,
  local: (_owner, hostKey) => legacyPanelView(hostKey, 'en-US')?.statuses as ConnectionStatuses | undefined,
})

export const configuredConnections = replica({
  name: 'configuredConnections',
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<ConfiguredConnections> => libraryHostOf(hostKey).integrations.checkConfiguredConnections(),
  fresh: Infinity,
  ...hostReadPolicy,
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
  ...hostReadPolicy,
})

export const integrationAccountChecks = replica({
  name: 'integrationAccountChecks',
  scope: 'device',
  read: (_owner: string, hostKey: string, integrationId: string) => libraryHostOf(hostKey).integrations.checkAccounts(integrationId),
  fresh: 30_000,
  refreshOnFocus: true,
  ...hostReadPolicy,
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
/** The window's connection signals while any surface shows connections (ref-counted); starting with values reads once. */
export function watchConnections(): () => void {
  if (watchers++ === 0) {
    window.addEventListener(CONNECTIONS_CHANGED, refreshConnections)
    stopPanels = onAssistantPanelChanged(undefined, refreshConnections)
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
