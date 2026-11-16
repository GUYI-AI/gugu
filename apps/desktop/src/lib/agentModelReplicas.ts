import type { SessionpageSessionCreateOptions, SessionpageSessionView } from '@gugu/session-core/session-record/contract'
import { useEffect } from 'react'
import { fetchCreateOptions, fetchPhoneCreateOptions } from '@/mobile/agent-watch/sessionpage-rpc'
import { fetchPlatformModelCatalog, fetchSessionCreateModels, readAgentModelSelection, type SessionCreateVia } from './agentModelSelection'
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

/** What one agent is set to use (desired / applied / the device's refusal), as the cloud row says. */
export const agentModelSelection = replica({
  name: 'agentModelSelection',
  scope: 'account',
  read: (_owner, agentUserId: string) => readAgentModelSelection(agentUserId),
  // The two agents opened last (2 of 4 before: the account block made room for the connections' first frame).
  persist: { maxBytes: 1024, maxEntries: 2 },
})

/**
 * The models a harness offers on a machine (one catalog per machine × harness × view × the model asked about, whose
 * efforts it carries): the new-session pages (desktop and phone) and the agent model pane read this one model. No push:
 * read again after five minutes. The last two are kept across restarts (the agent model pane's first frame).
 */
export const sessionCreateModels = replica({
  name: 'sessionCreateModels',
  scope: 'account',
  networkMode: (_deviceId: string, _harness: string, _view: unknown, _model: unknown, via: SessionCreateVia) => (via === 'local' ? 'always' : 'online'),
  read: (_owner, deviceId: string, harness: string, sessionView: SessionpageSessionView | null, model: string | null, via: SessionCreateVia) =>
    fetchSessionCreateModels(deviceId, harness, sessionView, model, via),
  fresh: 5 * 60_000,
  persist: { maxBytes: 3072, maxEntries: 2 },
})

/**
 * What a machine offers for a new session (harnesses, projects, the last-used set). No push: read on open (`fresh: 0`),
 * again after a session is created there (the last-used set changes), when the machine comes back, and on reload. Not
 * kept across restarts (it carries the machine's project list, which grows).
 */
export const sessionCreateOptions = replica({
  name: 'sessionCreateOptions',
  scope: 'account',
  read: (_owner, deviceId: string, via: 'machine' | 'phone'): Promise<SessionpageSessionCreateOptions> =>
    via === 'phone' ? fetchPhoneCreateOptions(deviceId) : fetchCreateOptions(deviceId),
  fresh: 0,
})
