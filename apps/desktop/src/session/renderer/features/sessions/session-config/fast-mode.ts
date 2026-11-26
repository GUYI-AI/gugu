import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import { CUSTOM_FAST_TOKEN_MULTIPLIER, FAST_PROTOCOLS, matchCustomModel, type CustomModelConnection } from '@gugu/session-core/models/custom-model';
import type { SessionOptionGroup } from '@gugu/session-core/session-record/contract';

/** A host-filtered native on/off group is a capability fact, not a model-name guess. */
export function fastModeValue(group: SessionOptionGroup | null | undefined): boolean | undefined {
  if (!group || !group.available.some(option => option.id === 'on') || !group.available.some(option => option.id === 'off')) return undefined;
  if (group.selected === null || group.selected === 'off') return false;
  return group.selected === 'on' ? true : undefined;
}

/** Fast's token multiple as declared: the custom model forwarder's own, else the provider's; undefined = none published. */
export function fastTokenMultiplier(capabilities: Pick<AgentCapabilities, 'acp'> | null | undefined, custom: boolean): number | undefined {
  return custom ? CUSTOM_FAST_TOKEN_MULTIPLIER : capabilities?.acp.liveSettings?.fast?.tokenMultiplier;
}

/** Static provider opt-in and native per-model facts must both agree. */
export function agentOffersFastMode(capabilities: Pick<AgentCapabilities, 'acp'> | null | undefined): boolean {
  const fast = capabilities?.acp.liveSettings?.fast;
  return capabilities?.acp.kind === 'supported' && fast?.channel === 'acp-config-option' && fast.ack !== 'none';
}

/** Offer Fast only from this model's actual native settings, on either billing route. */
export function sessionFastMode(input: {
  capabilities: Pick<AgentCapabilities, 'acp'> | null | undefined;
  route: 'own' | 'platform' | 'unknown';
  group: (SessionOptionGroup & { configId: string }) | null | undefined;
  /** Custom sessions only: whether this model and harness carry Fast (`customModelFastSupported`); absent elsewhere. */
  customSupported?: boolean;
  recorded?: boolean;
}): boolean | undefined {
  // A custom model's Fast is the session's own record, read by the model forwarder on every request.
  if (input.customSupported !== undefined) return input.customSupported ? input.recorded === true : undefined;
  if (input.route === 'unknown' || !agentOffersFastMode(input.capabilities) || input.group?.configId !== 'fast') return undefined;
  return fastModeValue(input.group);
}

/** A pre-start probe proves capability for its selected model only. Intent still defaults off. */
export function draftFastMode(input: {
  enabled: boolean;
  capabilities: Pick<AgentCapabilities, 'acp'> | null | undefined;
  modelId: string | null;
  platformModel: string | null;
  customSupported?: boolean;
  catalog: { kind: string; selected?: string | null; fastMode?: (SessionOptionGroup & { configId: string }) | null };
}): boolean | undefined {
  if (input.customSupported !== undefined) return input.customSupported ? input.enabled : undefined;
  if (input.platformModel || !input.modelId || input.catalog.kind !== 'ready' || input.catalog.selected !== input.modelId) return undefined;
  const supported = sessionFastMode({ capabilities: input.capabilities, route: 'own', group: input.catalog.fastMode });
  return supported === undefined ? undefined : input.enabled;
}

/**
 * Fast on a custom model: the model declares it and this harness reaches it directly over an OpenAI Chat or Responses
 * address. A converted route shares one forwarder key per record, so it cannot tell sessions apart and offers none.
 */
export function customModelFastSupported(
  connection: Pick<CustomModelConnection, 'endpoints' | 'keySaved' | 'harnessProtocols' | 'routes' | 'models'> | undefined,
  modelId: string | undefined,
  agent: { id: string; capabilities: Pick<AgentCapabilities, 'modelProtocols' | 'customModel'> } | undefined,
): boolean {
  if (!connection || !modelId || connection.models.find(({ id }) => id === modelId)?.fast !== true) return false;
  const protocols = agent?.capabilities.modelProtocols ?? [];
  const matched = matchCustomModel({ connection, modelId, harness: agent?.id, nativeProtocol: protocols[0], protocols, convertFrom: agent?.capabilities.customModel?.convertFrom ?? [] });
  return !!matched.endpoint && !matched.converted && FAST_PROTOCOLS.includes(matched.endpoint.protocol);
}
