import { platformModelAccessEnv } from '@gugu/core'
import { platformArmedEffort, type SessionModelCapability } from '@gugu/session-core/agents/plugins'
import { customModelEfforts, type CustomModelEntry, type ModelProtocol, type PiCustomModelProvider } from '@gugu/session-core/models/custom-model'
import { pluginRegistry } from '@gugu/session-plugins/agents'
import { materializeModelCapability, providerDeliversModelViaConfigFile } from '../capability-bundle'
import type { SessionpagePlatformModel } from './sessionpage-platform-model'

/** A custom provider uses the harness's model writer, without a platform billing lease. */
export function connectionModelLaunch(input: {
  providerId: string
  surface: 'cui' | 'tui'
  name: string
  endpoint: string
  apiKey: string
  models: readonly string[]
  protocol?: ModelProtocol
  capabilities?: CustomModelEntry
  connectionId?: string
  entries?: readonly CustomModelEntry[]
  piProviders?: readonly PiCustomModelProvider[]
  effort?: string
}): SessionpagePlatformModel {
  const [model, ...others] = input.models
  const plugin = pluginRegistry.get(input.providerId)
  if (!model && !plugin?.capabilities.sessionBundle.customModel?.modelOptional) throw new Error(`${input.providerId}: the custom connection names no model`)
  // The model's levels and the recorded one, armed the way a platform model's are.
  const efforts = (id: string) => customModelEfforts(input.entries?.find((entry) => entry.id === id), plugin?.capabilities.effort)
  const reasoningEfforts = model ? efforts(model) : null
  const nativeCredentials = input.providerId === 'claude' || input.providerId === 'codex' || input.providerId === 'antigravity' || (input.providerId === 'dsh' && !model)
  let modelCapability: SessionModelCapability | null = null
  if (!nativeCredentials) {
    const writer = plugin?.behavior.sessionBundle?.platformModel
    if (!plugin || plugin.capabilities.sessionBundle.platform.kind !== 'supported' || !writer) {
      throw new Error(`${input.providerId}: custom models need this harness's model writer`)
    }
    const declared = writer.declare({
      explicitModel: model, requestedEffort: platformArmedEffort(input.effort, reasoningEfforts, reasoningEfforts) ?? undefined, envOverride: () => undefined,
      platformProvider: { baseUrl: input.endpoint, apiKey: input.apiKey }, platformAccess: null,
      platformModels: others.length ? others.map((id) => ({ id, displayName: id, reasoningEfforts: efforts(id) })) : undefined,
      contextWindow: input.capabilities?.contextWindow, callableRoutes: {},
      protocolEnv: () => { throw new Error(`${input.providerId}: a custom model has no platform protocol environment`) },
    })
    modelCapability = {
      ...declared, providerName: input.name,
      ...(input.connectionId ? { customModels: { connectionId: input.connectionId, entries: input.entries ?? [], piProviders: input.piProviders } } : {}),
      ...(input.protocol === 'openai-responses' || input.protocol === 'openai-chat-completions' ? { wireProtocol: input.protocol } : {}),
      ...(input.protocol === 'anthropic-messages' || input.protocol === 'gemini-generate-content'
        ? { platformSettingsEnv: platformModelAccessEnv(input.protocol, input.endpoint, input.apiKey, input.capabilities?.contextWindow) }
        : {}),
    }
  }
  // Claude/Codex native credentials and Antigravity's gateway are delivered by the run context.
  // Claude emits its loopback address and local token in the native run context.
  const viaFile = providerDeliversModelViaConfigFile(input.providerId, input.surface === 'tui' ? 'tui' : 'acp')
  const loaded = modelCapability && !viaFile ? materializeModelCapability(modelCapability) : {}
  if (loaded.settingsOverride) throw new Error(`${input.providerId}: a custom model cannot ride a session settings document`)
  const spawnEnv = Object.fromEntries(Object.entries(loaded.spawnEnv ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return {
    accessSessionId: null, expiresAt: null, env: {}, model: null,
    spawnEnv, clientArgs: [], adapterArgs: input.surface === 'tui' ? [] : [...(loaded.extraArgs ?? [])],
    settingsDocumentPath: null,
    platformProvider: modelCapability?.platformProvider ?? null,
    contextWindow: input.capabilities?.contextWindow ?? null, reasoningEfforts,
    modelCapability, switchableModels: [],
  }
}

export function notOnPlatform(platform: SessionpagePlatformModel): boolean {
  return platform.accessSessionId === null && platform.modelCapability === null
}
