import { useEffect,useMemo,useSyncExternalStore,useCallback } from 'react'
import { connectionReadDelay } from '@/components/connections/connection-read-policy'
import { useConnectionReadNotice } from '@/components/connections/useConnectionReadNotice'
import { refreshFailure,replica,replicaAccount,useReplica } from '@/lib/replica'
import type { ConnectionClient } from '@gugu/core/cloud/connections'
import { ConnectionError } from '@gugu/core/cloud/connections'
import type { ConnectionMetadataStore } from '@/components/connections/connection-metadata'
import type { ConnectionRoute,createConnectionRouting } from '@gugu/core/cloud/connectionRouting'

/** Installed by the authenticated shell, before either settings bundle mounts. */
export interface ConnectionBridge {
  accountId(): string | null
  subscribeAccount(listener: () => void): () => void
  metadata(ownerId: string, deviceId?: string | null,route?: ConnectionRoute): ConnectionMetadataStore
  client: ConnectionClient
  routing: ReturnType<typeof createConnectionRouting>
  /**
   * Changes made outside this window (the owner's change bus). Never this window's own announcement
   * (`CONNECTIONS_CHANGED`): reacting here may announce (`store.invalidate()`), which must not come back here.
   */
  subscribeChanges(ownerId: string, listener: () => void): () => void
  retryOperation(operationId: string): Promise<void>
}
const KEY = '__GUGU_CONNECTIONS__' as const
export type ConnectionWindow = Window & { [KEY]?: ConnectionBridge }
export function connectionBridge(): ConnectionBridge {
  const bridge = typeof window === 'undefined' ? undefined : (window as ConnectionWindow)[KEY]
  if (!bridge) throw new ConnectionError('missing-identity','CONNECTION_SHELL_UNAVAILABLE')
  return bridge
}
const accountId = () => typeof window === 'undefined' ? null : (window as ConnectionWindow)[KEY]?.accountId() ?? null
const subscribeAccount = (listener: () => void) => typeof window === 'undefined' ? () => {} : (window as ConnectionWindow)[KEY]?.subscribeAccount(listener) ?? (() => {})

/**
 * @@@connection-route (@@@client-state-model) — which source this account's connections live in, at which epoch. The one copy: core's routing keeps
 * its last route here (`routeCache`). A lower epoch never replaces a higher one (`merge`). Signal tier: change bus, focus,
 * every 15 s while shown. `CONNECTIONS_CHANGED` is ❌ a source: reading on it would re-announce (the cycle #1922 D8 removed).
 */
export const connectionRoute = replica({
  name: 'connectionRoute',
  scope: 'account',
  read: (_owner: string): Promise<ConnectionRoute> => connectionBridge().routing.read(),
  merge: (shown: ConnectionRoute, next: ConnectionRoute) => (BigInt(next.epoch) < BigInt(shown.epoch) ? shown : next),
  refreshOnFocus: true,
  refreshEvery: 15_000,
  retry: 3,
  retryDelay: connectionReadDelay,
  watch: { start: (owner) => connectionBridge().subscribeChanges(owner,() => { void connectionRoute.refresh() }) },
})

/** Core routing's cache of the last route, as this replica's entry for the signed-in account (one copy, not two). */
export const routeCache = {
  get(ownerId: string): ConnectionRoute | undefined {
    if (replicaAccount().id !== ownerId) return undefined
    const reading = connectionRoute.peek()
    return reading.state === 'value' ? reading.value : undefined
  },
  set(ownerId: string,route: ConnectionRoute): void {
    if (replicaAccount().id === ownerId) connectionRoute.at().set(route)
  },
}

export function useConnectionAuthority() {
  const owner = useSyncExternalStore(subscribeAccount,accountId,() => null)
  const reading = useReplica(connectionRoute,owner ? [] : null)
  const route = reading.state === 'value' ? reading.value : undefined
  const error = refreshFailure(reading) ?? undefined
  // The notice is for an empty read episode: said once the retries are spent and nothing was ever read.
  useConnectionReadNotice(`authority:${owner}`,!!route,reading.state === 'error' ? Infinity : 0)
  const reload = useCallback(() => connectionRoute.refresh(),[])
  return { owner,route,error,reload,loading: reading.state === 'unknown' }
}

export function useOwnerConnectionStore(deviceId: string | null = null,route?: ConnectionRoute,enabled = true) {
  const owner = useSyncExternalStore(subscribeAccount,accountId,() => null)
  const store = useMemo(() => owner && enabled ? connectionBridge().metadata(owner,deviceId,route) : undefined,[owner,deviceId,route,enabled])
  useEffect(() => owner && store ? connectionBridge().subscribeChanges(owner,() => store.invalidate()) : undefined,[owner,store])
  return store
}
