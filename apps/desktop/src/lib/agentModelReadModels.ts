import { fetchAgentHarnessModels, fetchPlatformModelCatalog, readAgentModelSelection } from './agentModelSelection'
import { readModel } from './readModel'

/** The account's platform model catalog (settings → Model, the agent model pane); kept across restarts. */
export const platformModels = readModel({
  name: 'platformModels',
  scope: 'account',
  read: () => fetchPlatformModelCatalog(),
  fresh: 5 * 60_000,
  persist: true,
})

/** What one agent is set to use (desired / applied / the device's refusal), as the cloud row says. */
export const agentModelSelection = readModel({
  name: 'agentModelSelection',
  scope: 'account',
  read: (_owner, agentUserId: string) => readAgentModelSelection(agentUserId),
  persist: true,
})

/** The models an agent's own harness offers on its device. */
export const agentHarnessModels = readModel({
  name: 'agentHarnessModels',
  scope: 'account',
  read: (_owner, deviceId: string, harness: string, isLocal: boolean) => fetchAgentHarnessModels(deviceId, harness, isLocal),
  fresh: 5 * 60_000,
  persist: true,
})
