import type { SessionpageSessionCreateOptions, SessionpageSessionView } from '@gugu/session-core/session-record/contract'
import { useEffect } from 'react'
import { fetchCreateOptions, fetchPhoneCreateOptions } from '@/mobile/agent-watch/sessionpage-rpc'
import { fetchPlatformModelCatalog, fetchSessionCreateModels, readAgentModelSelection, type SessionCreateVia } from './agentModelSelection'
import { replica, useReplica, type Reading } from './replica'
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

/** Back in the foreground: focus and visibilitychange often arrive together, one switch reads once. */
const FOREGROUND_REFRESH_MIN_MS = 5_000

/** The catalog may have changed: a models-changed signal (#7092) or the window coming back (#7056: bought on the web, no push). */
export function followCatalogChanges(refresh: () => void): () => void {
  let lastAt = Date.now()
  const onForeground = () => {
    if (document.visibilityState === 'hidden') return
    const now = Date.now()
    if (now - lastAt < FOREGROUND_REFRESH_MIN_MS) return
    lastAt = now
    refresh()
  }
  window.addEventListener(PLATFORM_MODELS_CHANGED_EVENT, refresh)
  window.addEventListener('focus', onForeground)
  document.addEventListener('visibilitychange', onForeground)
  return () => {
    window.removeEventListener(PLATFORM_MODELS_CHANGED_EVENT, refresh)
    window.removeEventListener('focus', onForeground)
    document.removeEventListener('visibilitychange', onForeground)
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
