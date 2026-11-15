import { fetchAgentHarnessModels, fetchPlatformModelCatalog, readAgentModelSelection } from './agentModelSelection'
import { useEffect } from 'react'
import { replica, useReplica, type Reading } from './replica'
import type { PlatformCatalogModel } from './agentModelSelection'

const MENU_DETAILS = ['creditMultiplier', 'creditMultipliers', 'contextWindow', 'reasoningEfforts'] as const
const hasMenuDetails = (model: PlatformCatalogModel) => MENU_DETAILS.some((field) => field in model)

/** The catalog as read, with every row's menu details (❌ one restored from the snapshot, which carries none). */
export function catalogDetailed(models: readonly PlatformCatalogModel[]): boolean {
  return models.every((model) => model.creditMultipliers !== undefined && model.reasoningEfforts !== undefined)
}

/**
 * The account's platform model catalog (settings → Model, the agent model pane, and every composer's Gugu group, derived
 * per engine in platform-model-catalog.ts).
 *
 * Named `platformCatalog` (it was `platformModels`): the value gained per-protocol multipliers and reasoning levels, and a
 * model whose value changes shape takes a new name (lib/replica.ts) so an older build's snapshot is never read as this one.
 *
 * Kept across restarts without the menu details (`carry`): what a cold first frame draws from it is the settings → Model
 * list (id, name, enabled, hidden, members-only), and that is all the snapshot holds. Rows ≈ 150 B, so today's catalog
 * (~50 rows) is ~7.5 K and a catalog twice that size still fits under the cap. The details (multipliers, context window,
 * reasoning levels) are read again at once (a restored value is stale, I5); surfaces that draw them wait for that read
 * (`catalogDetailed`): the composer's model trigger (its effort label intersects the levels) and the agent model pane.
 */
export const platformModels = replica({
  name: 'platformCatalog',
  scope: 'account',
  read: () => fetchPlatformModelCatalog(),
  fresh: 5 * 60_000,
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
 * The catalog as a surface that draws its menu details reads it (the composer's Gugu group, the agent model pane): a value
 * restored from the snapshot carries none, so it is not known yet for them (`unknown`, or the failure of the read that
 * should bring them), and that read is asked now — a restored value may still be fresh by time, and nothing else would.
 */
export function useDetailedPlatformCatalog(wanted: boolean): Reading<PlatformCatalogModel[]> {
  const reading = useReplica(platformModels, wanted ? [] : null)
  const restored = reading.state === 'value' && !catalogDetailed(reading.value)
  useEffect(() => {
    if (restored) void platformModels.refresh()
  }, [restored])
  if (!restored) return reading
  return reading.state === 'value' && reading.error ? { state: 'error', error: reading.error } : { state: 'unknown' }
}

/**
 * The catalog's earlier names, registered without `persist` for one reason: a snapshot entry whose name has no model is
 * kept as "not registered yet" (its chunk may load later) and would lie in the account block for 30 days. Registered,
 * these names are judged like any model and, persisting nothing, their entries leave the snapshot at once. Never read.
 */
for (const retired of ['platformModels', 'platformModelsV2']) {
  replica({
    name: retired,
    scope: 'account',
    read: () => Promise.reject(new Error(`${retired} is retired: read platformCatalog`)),
  })
}

/** What one agent is set to use (desired / applied / the device's refusal), as the cloud row says. */
export const agentModelSelection = replica({
  name: 'agentModelSelection',
  scope: 'account',
  read: (_owner, agentUserId: string) => readAgentModelSelection(agentUserId),
  persist: { maxBytes: 1024, maxEntries: 4 },
})

/** The models an agent's own harness offers on its device. */
export const agentHarnessModels = replica({
  name: 'agentHarnessModels',
  scope: 'account',
  read: (_owner, deviceId: string, harness: string, isLocal: boolean) => fetchAgentHarnessModels(deviceId, harness, isLocal),
  fresh: 5 * 60_000,
  persist: { maxBytes: 3072, maxEntries: 2 },
})
