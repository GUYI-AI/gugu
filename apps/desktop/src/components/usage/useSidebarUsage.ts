import { useState } from 'react'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import type { SubscriptionUsageReading } from '@gugu/session-core/agents/plugins'
import { useReplicas, type Reading } from '@/lib/replica'
import { connectionDetails, harnessConnections, refreshModelSubscriptions, subscriptionUsage } from '@renderer/features/settings/subscriptions/subscription-queries'
import { nativeConfigured, type ConnectionDetails } from '@renderer/features/settings/subscriptions/listed-connections'
import { subscriptionWindow, type SubscriptionUsageProvider } from './subscriptionUsagePresentation'

const PROVIDERS: SubscriptionUsageProvider[] = ['claude', 'codex']
type Subject = [null, string, string]
export interface SidebarSubscription {
  provider: SubscriptionUsageProvider
  connection: HarnessConnection
  details: Reading<ConnectionDetails>
  usage: Reading<SubscriptionUsageReading>
}

/** The rail and account menus observe the same device-owned readings. No second cache. */
export function useSidebarUsage() {
  const lists = useReplicas(harnessConnections, PROVIDERS.map((provider): [null, string] => [null, provider]))
  const offered = lists.flatMap((list, index) => list.state === 'value'
    ? list.value.map(connection => ({ provider: PROVIDERS[index]!, connection })) : [])
  const details = useReplicas(connectionDetails, offered.map(({ provider, connection }): Subject => [null, provider, connection.id]))
  const accounts = offered.flatMap((item, index) => {
    const reading = details[index]!
    if (reading.state === 'value') {
      if (item.connection.kind === 'native' && !nativeConfigured(reading.value)) return []
      if (reading.value.plan?.payer === 'api-key' || reading.value.plan?.payer === 'custom-endpoint') return []
      if (reading.value.status.kind === 'authenticated' && reading.value.status.credentialKind === 'api-key') return []
    }
    return [{ ...item, details: reading }]
  })
  const signedIn = accounts.filter(item => item.details.state === 'value' && item.details.value.status.kind === 'authenticated')
  const usages = useReplicas(subscriptionUsage, signedIn.map(({ provider, connection }): Subject => [null, provider, connection.id]))
  const byAccount = new Map(signedIn.map((item, index) => [`${item.provider}:${item.connection.id}`, usages[index]!]))
  const subscriptions: SidebarSubscription[] = accounts.map(item => ({
    ...item, usage: byAccount.get(`${item.provider}:${item.connection.id}`) ?? { state: 'unknown' },
  }))
  const rings = subscriptions.flatMap(item => {
    if (item.usage.state !== 'value' || item.usage.value.kind !== 'windows') return []
    const week = subscriptionWindow(item.usage.value.windows, 10_080)
    return week ? [{ ...item, week }] : []
  })
  const [refreshing, setRefreshing] = useState(false)
  function readOnOpen() {
    // Respect the existing freshness policy; opening the popup does not force vendor requests.
    void Promise.allSettled([
      ...PROVIDERS.map(provider => harnessConnections.prefetch(null, provider)),
      ...accounts.map(({ provider, connection }) => connectionDetails.prefetch(null, provider, connection.id)),
      ...signedIn.map(({ provider, connection }) => subscriptionUsage.prefetch(null, provider, connection.id)),
    ])
  }
  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      // Reuse the model page's account-bound refresh and failure retention.
      await refreshModelSubscriptions(null, PROVIDERS)
    } finally {
      setRefreshing(false)
    }
  }
  return {
    subscriptions, rings, refreshing, refresh, readOnOpen,
    pending: lists.some(list => list.state === 'unknown') || details.some(detail => detail.state === 'unknown'),
    failures: lists.flatMap((list, index) => list.state === 'error' || list.state === 'value' && list.error
      ? [{ provider: PROVIDERS[index]!, error: list.error! }] : []),
  }
}
