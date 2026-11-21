import { isAssistantPanelReadRetryable, retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead'
import { isCloudComputerNotOpen } from '@gugu/core/cloud/cloudComputer'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import { ConnectionError } from '@gugu/core/cloud/connections'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { connectionBridge, connectionRoute } from '@/lib/connectionBridge'
import { refreshTag, refreshTagOn, replica, useReplica, type Reading } from '@/lib/replica'
import { onAssistantPanelChanged } from '@/components/assistant/assistant-panel-replica'
import { isTooOld, libraryHostOf, peekLibraryHost } from '@/session/renderer/features/library/library-host'
import { peekAssistantPanelIntegrations } from '@/components/assistant/assistant-panel-integrations'
import type { rpc } from '@/session/renderer/lib/ipc'
import type { ConnectionMetadataSnapshot, ConnectionMetadataStore } from './connection-metadata'
import { connectionNeedsConfirmation } from './connection-application-status'
import { connectionReadDelay } from './connection-read-policy'
import { CONNECTIONS_CHANGED } from './owner-connection-metadata'

/**
 * @@@connection-replicas — the connections library's data (@@@client-state-model). Signal tier: `CONNECTIONS_CHANGED` and
 * panel changes refresh them (`chatChannels`' watch, the tag `CONNECTIONS`). Host-keyed ones are device scope (a host bound to an account carries its owner).
 */

/** Every connection model (a change anywhere: read them again where shown). */
export const CONNECTIONS = 'connections'
/** The host-keyed ones: `refreshTag(CONNECTIONS_ON_HOST, hostKey)` after that host's authorization changed. */
export const CONNECTIONS_ON_HOST = 'connections-on-host'

/** No cloud computer: the channels live there, so there are none to list — an answer, not a failure. */
export type ChatChannelsValue = ChatChannelList | { absent: true }

export const chatChannels = replica({
  name: 'chatChannels',
  tags: [CONNECTIONS],
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
  // As fresh as its poll: a surface opening within it is no reason to read again.
  fresh: 10_000,
  // A connection change (made here, heard from the owner's bus, an assistant panel's) reads every connection model again
  // while one is shown (or held: the integrations provider). Starting reads them once: what changed while nobody listened.
  watch: {
    start: () => {
      void refreshTag(CONNECTIONS)
      return refreshTagOn(CONNECTIONS, (fire) => {
        window.addEventListener(CONNECTIONS_CHANGED, fire)
        const stopPanels = onAssistantPanelChanged(undefined, fire)
        return () => { window.removeEventListener(CONNECTIONS_CHANGED, fire); stopPanels() }
      })
    },
  },
})

function ownerRoute(epoch: string) {
  const route = connectionBridge().routing.peek()
  if (route?.mode !== 'owner' || route.epoch !== epoch) throw new ConnectionError('route-changed', 'CONNECTION_ROUTE_CHANGED')
  return route
}

export const ownerConnections = replica({
  name: 'ownerConnections',
  tags: [CONNECTIONS],
  scope: 'account',
  read: (owner: string, epoch: string, deviceId: string | null): Promise<ConnectionMetadataSnapshot> =>
    connectionBridge().metadata(owner, deviceId, ownerRoute(epoch)).snapshot(),
  fresh: Infinity,
  refreshOnFocus: true,
  refreshEvery: (value) => (value?.application.some(connectionNeedsConfirmation) ? 3_000 : 15_000),
  // After 3 failed retries the reading is an error (said once, useConnectionReadNotice); the poll keeps asking.
  retry: 3,
  retryDelay: connectionReadDelay,
})

export function prefetchConnections(): void {
  void chatChannels.prefetch()
  void connectionRoute.fetch().then((route) => {
    if (route.mode === 'owner') void ownerConnections.prefetch(route.epoch, null)
  }, () => {})
}

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

// Only a host behind the assistant panel retries (its computer waking); another machine is not (an offline one would only hang).
const panelHost = (hostKey: string) => !!peekLibraryHost(hostKey)?.assistantPanelExpected
const hostRetry = (failures: number, error: Error, hostKey: string) => panelHost(hostKey) && retryAssistantPanelRead(failures, error)
const hostRecheck = (_value: unknown, error: Error | null, hostKey: string) =>
  error && panelHost(hostKey) && isAssistantPanelReadRetryable(error) ? 30_000 : false
const hostReadPolicy = { retry: hostRetry, retryDelay: connectionReadDelay, refreshEvery: hostRecheck }
const hostPolled = { fresh: 30_000, refreshOnFocus: true, ...hostReadPolicy }

const legacyPanelView = (hostKey: string, locale: string) => {
  const host = peekLibraryHost(hostKey)
  return host?.assistantPanel ? peekAssistantPanelIntegrations(host.assistantPanel, locale) : undefined
}

export const integrationsCatalog = replica({
  name: 'integrationsCatalog',
  tags: [CONNECTIONS],
  scope: 'device',
  read: (_owner: string, hostKey: string, locale: string): Promise<IntegrationList> => libraryHostOf(hostKey).integrations.list(locale),
  fresh: Infinity,
  ...hostReadPolicy,
  local: (_owner, hostKey, locale) => legacyPanelView(hostKey, locale)?.items as IntegrationList | undefined,
})

export const integrationStatuses = replica({
  name: 'integrationStatuses',
  tags: [CONNECTIONS, CONNECTIONS_ON_HOST],
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<ConnectionStatuses> => libraryHostOf(hostKey).integrations.checkAllConnections(),
  ...hostPolled,
  local: (_owner, hostKey) => legacyPanelView(hostKey, 'en-US')?.statuses as ConnectionStatuses | undefined,
})

export const configuredConnections = replica({
  name: 'configuredConnections',
  tags: [CONNECTIONS, CONNECTIONS_ON_HOST],
  scope: 'device',
  read: (_owner: string, hostKey: string): Promise<ConfiguredConnections> => libraryHostOf(hostKey).integrations.checkConfiguredConnections(),
  fresh: Infinity,
  ...hostReadPolicy,
  local: (_owner, hostKey) => legacyPanelView(hostKey, 'en-US')?.configured as ConfiguredConnections | undefined,
})

export const integrationAccounts = replica({
  name: 'integrationAccounts',
  tags: [CONNECTIONS, CONNECTIONS_ON_HOST],
  scope: 'device',
  read: async (_owner: string, hostKey: string, integrationId: string): Promise<IntegrationAccounts> => {
    try {
      return { supported: true, accounts: await libraryHostOf(hostKey).integrations.accounts(integrationId) }
    } catch (error) {
      if (isTooOld(error)) return { supported: false }
      throw error
    }
  },
  ...hostPolled,
})

export const integrationAccountChecks = replica({
  name: 'integrationAccountChecks',
  tags: [CONNECTIONS, CONNECTIONS_ON_HOST],
  scope: 'device',
  read: (_owner: string, hostKey: string, integrationId: string) => libraryHostOf(hostKey).integrations.checkAccounts(integrationId),
  ...hostPolled,
})

