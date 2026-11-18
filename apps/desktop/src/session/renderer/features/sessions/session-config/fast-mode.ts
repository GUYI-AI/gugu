import type { AgentCapabilities } from '@shared/core/agents/agent-payload';
import type { SessionOptionGroup } from '@gugu/session-core/session-record/contract';

/** A host-filtered native on/off group is a capability fact, not a model-name guess. */
export function fastModeValue(group: SessionOptionGroup | null | undefined): boolean | undefined {
  if (!group || !group.available.some(option => option.id === 'on') || !group.available.some(option => option.id === 'off')) return undefined;
  if (group.selected === null || group.selected === 'off') return false;
  return group.selected === 'on' ? true : undefined;
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
}): boolean | undefined {
  if (input.route === 'unknown' || !agentOffersFastMode(input.capabilities) || input.group?.configId !== 'fast') return undefined;
  return fastModeValue(input.group);
}

/** A pre-start probe proves capability for its selected model only. Intent still defaults off. */
export function draftFastMode(input: {
  enabled: boolean;
  capabilities: Pick<AgentCapabilities, 'acp'> | null | undefined;
  modelId: string | null;
  platformModel: string | null;
  catalog: { kind: string; selected?: string | null; fastMode?: (SessionOptionGroup & { configId: string }) | null };
}): boolean | undefined {
  if (input.platformModel || !input.modelId || input.catalog.kind !== 'ready' || input.catalog.selected !== input.modelId) return undefined;
  const supported = sessionFastMode({ capabilities: input.capabilities, route: 'own', group: input.catalog.fastMode });
  return supported === undefined ? undefined : input.enabled;
}
