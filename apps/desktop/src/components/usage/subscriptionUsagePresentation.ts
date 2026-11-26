import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'

export type SubscriptionUsageProvider = 'claude' | 'codex'

// Geometry from react-activity-rings (MIT), not a new ring drawing:
// https://github.com/JonasDoesThings/react-activity-rings/blob/891656158768694a1f327ea5d414085b2819a55f/src/components/ActivityRings.tsx
export const USAGE_RING_INITIAL_RADIUS = 30
export const USAGE_RING_WIDTH = 12
export const USAGE_RING_GAP = 0.75

export function remainingUsagePercent(window: SubscriptionUsageWindow): number | null {
  return Number.isFinite(window.usedPercent) ? 100 - Math.min(100, Math.max(0, window.usedPercent)) : null
}

/** Prefer the provider-wide window; grouped-only limits retain their group label. */
export function subscriptionWindow(windows: readonly SubscriptionUsageWindow[], minutes: number): SubscriptionUsageWindow | undefined {
  const matches = windows.filter(window => window.windowMinutes === minutes && remainingUsagePercent(window) !== null)
  return matches.find(window => !window.group) ?? matches.reduce<SubscriptionUsageWindow | undefined>((least, window) =>
    !least || window.usedPercent > least.usedPercent ? window : least, undefined)
}
