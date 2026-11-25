import { chatModel, customModelOptionId, matchCustomModel, type CustomModelConnection, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { providerPresets, subscriptionPlans, type ProviderPreset } from '@gugu/session-core/models/provider-presets';
import type { SubscriptionPlanReading } from '@gugu/session-core/agents/plugins';
import { vendorName } from '@/i18n/vendorName';
import { getDomainWithoutSuffix } from 'tldts';
import { modelProviderIcon } from './model-provider-icon';
import { resolveModelProvider } from './model-provider';
import { openCustomModelRouteRepair } from '@renderer/lib/open-shell-settings';

/** Which vendor an address belongs to: its registrable domain without the public suffix (`api.deepseek.com` → `deepseek`). An IP or a local name has none. */
export function vendorTag(baseUrl: string | undefined): string | undefined {
  return (baseUrl && getDomainWithoutSuffix(baseUrl)) || undefined;
}

/**
 * The tag on a row the person configured themselves (owner 11-19: Gugu's own models carry none; owner 11-24 draft,
 * 20:23 and 20:45 on 11-25). A coding plan says whose plan it is, the same word as its Settings group (智谱 / Kimi /
 * 火山方舟 / Z.ai): a key does not tell its tier. Pay-as-you-go — a preset or an address typed by hand — says the domain
 * it goes to, without the suffix (openai / deepseek / bigmodel).
 */
export function connectionTag(preset: ProviderPreset | undefined, baseUrl: string | undefined): string | undefined {
  return preset?.group === 'coding-plan' && preset.vendor ? vendorName(preset.vendor) : vendorTag(baseUrl);
}

/** What a harness's own sign-in reads as: the sign-in reading's kind, and the plan reading when there is one. */
export type OwnSignIn = { credentialKind?: 'subscription' | 'api-key'; plan?: SubscriptionPlanReading | null };

/**
 * The tag on a harness's own models (owner 11-24 draft): signed in with a plan, the plan as the vendor sells it
 * (「ChatGPT Plus」「Claude Max 20x」), falling back to the vendor (「ChatGPT」「Claude」) while the tier cannot be read;
 * on a pay-as-you-go key, the official API's domain (openai / anthropic); pointed at another service, its domain.
 * Harnesses without a plan sign-in keep no tag.
 */
export function ownModelTag(agentId: string | null | undefined, signIn: OwnSignIn = {}): string | undefined {
  const plan = agentId ? subscriptionPlans[agentId] : undefined;
  if (!plan) return undefined;
  const reading = signIn.plan ?? undefined;
  if (reading?.payer === 'custom-endpoint') return vendorTag(reading.endpoint);
  if (reading?.payer === 'api-key' || (reading?.payer !== 'subscription' && signIn.credentialKind === 'api-key')) {
    return vendorTag(providerPresets.find(({ id }) => id === plan.apiPreset)?.endpoints[0]?.baseUrl);
  }
  return reading?.payer === 'subscription' && reading.plan ? vendorName(reading.plan) : vendorName(plan.vendor);
}

export function customComposerOptions(
  connections: readonly CustomModelConnection[], agent: (Pick<AgentPayload, 'id' | 'name'> & { capabilities: Pick<AgentPayload['capabilities'], 'modelProtocols' | 'customModel'> }) | undefined,
  translate: ReturnType<typeof useSessionMessages>['translate'], repairMachine?: string | null,
): Record<string, ComposerModelOption> {
  const protocols = agent?.capabilities.modelProtocols ?? [];
  const incoming = protocols[0];
  const convertFrom = agent?.capabilities.customModel?.convertFrom ?? [];
  const accepted = [...protocols, ...convertFrom];
  const protocolName = (protocol: ModelProtocol) => translate(`customModels.${protocol}`);
  return Object.fromEntries(connections.filter(({ keySaved }) => keySaved).flatMap((connection) => {
    const preset = providerPresets.find(({ id }) => id === connection.preset);
    const tag = connectionTag(preset, connection.endpoints[0]?.baseUrl);
    return connection.models.filter(chatModel).map((model) => {
      const matched = matchCustomModel({ connection, modelId: model.id, harness: agent?.id, nativeProtocol: incoming, protocols, convertFrom });
      const required = protocols.map(protocolName).join(' / ');
      const actual = connection.endpoints.map(({ protocol }) => protocolName(protocol)).join(' / ');
      const reason = matched.reason === 'unsupported' ? translate('customModels.unsupported', { harness: agent?.name ?? '' })
        : matched.reason === 'protocol' ? translate(connection.preset ? 'customModels.protocolPreset' : 'customModels.protocolCustom', { harness: agent?.name ?? '', required, actual, provider: connection.name }) : undefined;
      let disabledAction: ComposerModelOption['disabledAction'];
      if (matched.reason === 'protocol' && incoming && repairMachine !== undefined) {
        const endpoint = connection.endpoints.find(({ protocol }) => accepted.includes(protocol));
        const matchingRoute = connection.routes?.find(({ outgoing, modelId, baseUrl }) =>
          (!modelId || modelId === model.id) && accepted.includes(outgoing) && (baseUrl ||
            connection.endpoints.some(({ protocol }) => protocol === outgoing)));
        disabledAction = {
          label: translate('customModels.addRouteForModel'),
          open: (onClose) => openCustomModelRouteRepair({
            machine: repairMachine, connection, onClose,
            route: { incoming, outgoing: matchingRoute?.outgoing ?? endpoint?.protocol ?? incoming,
              modelId: model.id, baseUrl: matchingRoute?.baseUrl },
          }),
        };
      }
      return [customModelOptionId({ connectionId: connection.id, modelId: model.id }), {
        name: model.label || model.id,
        // No group heading: the vendor tag already says this one is the person's own (owner 11-19).
        // Search matches it like the tag; a record whose address has no vendor keeps its own name.
        providerLabel: tag ?? connection.name,
        ...(tag ? { tag } : {}),
        // A preset draws its own logo; an address of the person's own draws the maker of the model it serves
        // (OpenRouter serving qwen/… → Qwen). Neither → the menu's generic icon (every row has one, owner 11-25).
        icon: modelProviderIcon(preset ? { id: preset.id, name: preset.name, iconKey: preset.icon } : resolveModelProvider(model.id, model.label)),
        description: connection.name,
        ...(reason ? { disabled: true, disabledReason: reason } : {}),
        ...(disabledAction ? { disabledAction } : {}),
        ...('contextWindow' in model && model.contextWindow ? { modelFeatures: { contextWindowSize: model.contextWindow } } : {}),
        ...('maxOutput' in model && model.maxOutput ? { facts: [{ label: translate('customModels.output'), value: model.maxOutput.toLocaleString() }] } : {}),
      } satisfies ComposerModelOption];
    });
  }));
}
