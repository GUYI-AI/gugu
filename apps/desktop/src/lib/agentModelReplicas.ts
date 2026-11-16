import type { SessionpageSessionCreateOptions, SessionpageSessionView } from '@gugu/session-core/session-record/contract'
import { useEffect } from 'react'
import { fetchCreateOptions, fetchPhoneCreateOptions } from '@/mobile/agent-watch/sessionpage-rpc'
import { fetchPlatformModelCatalog, fetchSessionCreateModels, readAgentModelSelection, type SessionCreateVia } from './agentModelSelection'
import { replica, useReplica, type Reading } from './replica'
import { rendererLogger } from './log'
import { PLATFORM_MODELS_CHANGED_EVENT } from '@shared/core/agents/platform-model'
import type { PlatformCatalogModel } from './agentModelSelection'

const MENU_DETAILS = ['creditMultiplier', 'creditMultipliers', 'contextWindow', 'reasoningEfforts'] as const
const hasMenuDetails = (model: PlatformCatalogModel) => MENU_DETAILS.some((field) => field in model)

/** The catalog as read, with every row's menu details (❌ one restored from the snapshot, which carries none). */
export function catalogDetailed(models: readonly PlatformCatalogModel[]): boolean {
  return models.every((model) => model.creditMultipliers !== undefined && model.reasoningEfforts !== undefined)
}

/** The account's platform model catalog, kept without the menu details (`carry`; ~50 rows ≈ 7.5 K); detail surfaces wait (`catalogDetailed`). */
export const platformModels = replica({
  name: 'platformCatalog',
  scope: 'account',
  read: () => fetchPlatformModelCatalog(),
  fresh: 5 * 60_000,
  watch: { start: () => followCatalogChanges(() => { void platformModels.refresh() }) },
  persist: {
    maxBytes: 16384,
    maxEntries: 1,
    // A value already without them is returned as is: a restore judges "carried differently" by identity.
    carry: (models: PlatformCatalogModel[]): PlatformCatalogModel[] => (models.some(hasMenuDetails)
      ? models.map(({ creditMultiplier: _m, creditMultipliers: _ms, contextWindow: _c, reasoningEfforts: _r, ...kept }) => kept)
      : models),
  },
})

/**
 * The catalog may have changed: a models-changed signal (#7092), or the account's plan changed (#7056: a membership
 * bought on the web; the credits read it on the return, nothing pushes here). ❌ Every focus or return: the catalog read is
 * the costly one, and a return with the same plan changes nothing in it.
 */
export function followCatalogChanges(refresh: () => void): () => void {
  window.addEventListener(PLATFORM_MODELS_CHANGED_EVENT, refresh)
  // Loaded on first use: the billing module (and its credit reads) stays out of this module's importers' graph.
  let stopPlan: (() => void) | null = null
  let stopped = false
  void import('./billing/useSpendingPower').then(
    ({ onPlanChange }) => { if (!stopped) stopPlan = onPlanChange(refresh) },
    (error: unknown) => { rendererLogger('model-catalog').error({ error: String(error) }, 'the billing module could not load: the catalog does not follow plan changes') },
  )
  return () => {
    stopped = true
    window.removeEventListener(PLATFORM_MODELS_CHANGED_EVENT, refresh)
    stopPlan?.()
  }
}

/** The catalog for a surface that draws its menu details: a restored value (none carried) is unknown to it, and the read is asked now. */
export function useDetailedPlatformCatalog(wanted: boolean): Reading<PlatformCatalogModel[]> {
  const reading = useReplica(platformModels, wanted ? [] : null)
  const restored = reading.state === 'value' && !catalogDetailed(reading.value)
  useEffect(() => {
    if (restored) void platformModels.refresh()
  }, [restored])
  if (!restored) return reading
  return reading.state === 'value' && reading.error ? { state: 'error', error: reading.error } : { state: 'unknown' }
}

/** What one agent is set to use (desired / applied / the device's refusal), as the cloud row says. */
export const agentModelSelection = replica({
  name: 'agentModelSelection',
  scope: 'account',
  read: (_owner, agentUserId: string) => readAgentModelSelection(agentUserId),
  // The two agents opened last.
  persist: { maxBytes: 1024, maxEntries: 2 },
})

/** The models a harness offers on a machine (per machine × harness × view × model asked about). No push; the last two kept (the pane's first frame). */
export const sessionCreateModels = replica({
  name: 'sessionCreateModels',
  scope: 'account',
  networkMode: (_deviceId: string, _harness: string, _view: unknown, _model: unknown, via: SessionCreateVia) => (via === 'local' ? 'always' : 'online'),
  read: (_owner, deviceId: string, harness: string, sessionView: SessionpageSessionView | null, model: string | null, via: SessionCreateVia) =>
    fetchSessionCreateModels(deviceId, harness, sessionView, model, via),
  fresh: 5 * 60_000,
  persist: { maxBytes: 3072, maxEntries: 2 },
})

/** What a machine offers for a new session. No push: read on open; not kept (its project list grows). */
export const sessionCreateOptions = replica({
  name: 'sessionCreateOptions',
  scope: 'account',
  read: (_owner, deviceId: string, via: 'machine' | 'phone'): Promise<SessionpageSessionCreateOptions> =>
    via === 'phone' ? fetchPhoneCreateOptions(deviceId) : fetchCreateOptions(deviceId),
  fresh: 0,
})
