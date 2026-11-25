import { chatModel, customModelOptionId, matchCustomModel, type CustomModelConnection, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { getDomainWithoutSuffix } from 'tldts';
import { modelProviderIcon } from './model-provider-icon';
import { openCustomModelRouteRepair } from '@renderer/lib/open-shell-settings';

/** Which vendor an address belongs to: its registrable domain without the public suffix (`api.deepseek.com` → `deepseek`). An IP or a local name has none. */
export function vendorTag(baseUrl: string | undefined): string | undefined {
  return (baseUrl && getDomainWithoutSuffix(baseUrl)) || undefined;
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
    const tag = vendorTag(connection.endpoints[0]?.baseUrl);
    return connection.models.filter(chatModel).map((model) => {
      const matched = matchCustomModel({ connection, modelId: model.id, harness: agent?.id, nativeProtocol: incoming, protocols, convertFrom });
      const required = protocols.map(protocolName).join(' / ');
      const actual = connection.endpoints.map(({ protocol }) => protocolName(protocol)).join(' / ');
      const reason = matched.reason === 'unsupported' ? translate('customModels.unsupported', { harness: agent?.name ?? '' })
        : matched.reason === 'protocol' ? translate(connection.preset ? 'customModels.protocolPreset' : 'customModels.protocolCustom', { harness: agent?.name ?? '', required, actual, provider: connection.name }) : undefined;
      const preset = providerPresets.find(({ id }) => id === connection.preset);
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
        // The filter pill reads like the tag; a record whose address has no vendor keeps its own name.
        providerLabel: tag ?? connection.name,
        ...(tag ? { tag } : {}),
        icon: modelProviderIcon(preset ? { id: preset.id, name: preset.name, iconKey: preset.icon } : null),
        description: connection.name,
        ...(reason ? { disabled: true, disabledReason: reason } : {}),
        ...(disabledAction ? { disabledAction } : {}),
        ...('contextWindow' in model && model.contextWindow ? { modelFeatures: { contextWindowSize: model.contextWindow } } : {}),
        ...('maxOutput' in model && model.maxOutput ? { facts: [{ label: translate('customModels.output'), value: model.maxOutput.toLocaleString() }] } : {}),
      } satisfies ComposerModelOption];
    });
  }));
}
