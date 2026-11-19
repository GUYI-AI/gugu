import type { SubscriptionUsageWindow } from '@gugu/session-core/agents/plugins'

export type SubscriptionUsageProvider = 'claude' | 'codex'

// Owner-approved palette, 2026-11-19. Rings and popup bars consume this same table.
// Silver keeps its fill on light surfaces; the separate edge preserves its boundary.
export const SUBSCRIPTION_USAGE_COLORS = {
  "claude": {
    "fill": "var(--usage-brand-claude-fill)",
    "edgeLight": "var(--usage-brand-claude-edgeLight)",
    "edgeDark": "var(--usage-brand-claude-edgeDark)",
    "trackLight": "var(--usage-brand-claude-trackLight)",
    "trackDark": "var(--usage-brand-claude-trackDark)"
  },
  "codex": {
    "fill": "var(--usage-brand-codex-fill)",
    "edgeLight": "var(--usage-brand-codex-edgeLight)",
    "edgeDark": "var(--usage-brand-codex-edgeDark)",
    "trackLight": "var(--usage-brand-codex-trackLight)",
    "trackDark": "var(--usage-brand-codex-trackDark)"
  }
} as const

// Geometry from react-activity-rings (MIT), not a new ring drawing:
// https://github.com/JonasDoesThings/react-activity-rings/blob/891656158768694a1f327ea5d414085b2819a55f/src/components/ActivityRings.tsx
export const USAGE_RING_INITIAL_RADIUS = 30
export const USAGE_RING_WIDTH = 12
export const USAGE_RING_GAP = 0.75

/** Geometry is returned in outside-to-inside order, matching the popup's account order. */
export function usageRingGeometry(count: number) {
  const size = 2 * (USAGE_RING_INITIAL_RADIUS + count * (USAGE_RING_WIDTH + USAGE_RING_GAP))
  return {
    size,
    center: size / 2,
    radii: Array.from({ length: count }, (_, index) => {
      const innerIndex = count - index - 1
      return USAGE_RING_INITIAL_RADIUS + innerIndex * USAGE_RING_WIDTH + USAGE_RING_WIDTH / 2 + innerIndex * USAGE_RING_GAP
    }),
  }
}

export function remainingUsagePercent(window: SubscriptionUsageWindow): number | null {
  return Number.isFinite(window.usedPercent) ? 100 - Math.min(100, Math.max(0, window.usedPercent)) : null
}

/** Prefer the provider-wide window; grouped-only limits retain their group label. */
export function subscriptionWindow(windows: readonly SubscriptionUsageWindow[], minutes: number): SubscriptionUsageWindow | undefined {
  const matches = windows.filter(window => window.windowMinutes === minutes && remainingUsagePercent(window) !== null)
  return matches.find(window => !window.group) ?? matches.reduce<SubscriptionUsageWindow | undefined>((least, window) =>
    !least || window.usedPercent > least.usedPercent ? window : least, undefined)
}
