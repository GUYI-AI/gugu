import { fetchAgentHarnessModels, fetchPlatformModelCatalog, readAgentModelSelection } from './agentModelSelection'
import { replica } from './replica'

/**
 * The account's platform model catalog (settings → Model, the agent model pane, and every composer's Gugu group, derived
 * per engine in platform-model-catalog.ts); kept across restarts. Named v2 since it carries the per-protocol multipliers and
 * the reasoning levels (an older snapshot's entries lack them and age out).
 */
export const platformModels = replica({
  name: 'platformModelsV2',
  scope: 'account',
  read: () => fetchPlatformModelCatalog(),
  fresh: 5 * 60_000,
  persist: { maxBytes: 16384, maxEntries: 1 },
})

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
