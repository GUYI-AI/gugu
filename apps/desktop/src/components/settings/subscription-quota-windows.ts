import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'
import { useSubscriptionUsage } from '@renderer/features/settings/subscriptions/subscription-queries'
import { subscriptionWindow, type SubscriptionUsageProvider } from '../usage/subscriptionUsagePresentation'

/** The 5-hour and weekly windows a connection's reading has, if any: what the inline bars draw. */
export function useQuotaWindows(machine: string | null, provider: SubscriptionUsageProvider, connectionId: string, enabled: boolean) {
  const usage = useSubscriptionUsage(machine, provider, connectionId, enabled)
  const reading = usage.state === 'value' ? usage.value : undefined
  const windows = reading?.kind === 'windows' ? [subscriptionWindow(reading.windows, 300), subscriptionWindow(reading.windows, 10_080)]
    .filter((window): window is SubscriptionUsageWindow => window !== undefined) : []
  return { usage, reading, windows }
}
