import { customModelOptionId, matchCustomModel, type CustomModelConnection, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { modelProviderIcon } from './model-provider-icon';

export function customComposerOptions(
  connections: readonly CustomModelConnection[], agent: (Pick<AgentPayload, 'id' | 'name'> & { capabilities: Pick<AgentPayload['capabilities'], 'modelProtocols' | 'customModel'> }) | undefined,
  device: string, translate: ReturnType<typeof useSessionMessages>['translate'],
): Record<string, ComposerModelOption> {
  const protocols = agent?.capabilities.modelProtocols ?? [];
  const protocolName = (protocol: ModelProtocol) => translate(`customModels.${protocol}`);
  return Object.fromEntries(connections.flatMap((connection) => {
    const entries = connection.models.length ? connection.models : [{ id: undefined }];
    return entries.map((model) => {
      const matched = matchCustomModel({ connection, nativeProtocol: protocols[0], protocols,
        hasModel: Boolean(model.id), allowDefaultModel: agent?.capabilities.customModel?.modelOptional });
      const required = protocols.map(protocolName).join(' / ');
      const actual = connection.endpoints.map(({ protocol }) => protocolName(protocol)).join(' / ');
      const reason = matched.reason === 'unsupported' ? translate('customModels.unsupported', { harness: agent?.name ?? '' })
        : matched.reason === 'missing-key' ? translate('customModels.missingKey', { device })
          : matched.reason === 'no-model' ? translate('customModels.noModel')
            : matched.reason === 'protocol' ? translate(connection.preset ? 'customModels.protocolPreset' : 'customModels.protocolCustom', { harness: agent?.name ?? '', required, actual, provider: connection.name }) : undefined;
      const preset = providerPresets.find(({ id }) => id === connection.preset);
      const name = model.id ? ('label' in model && model.label || model.id) : translate('customModels.cliDefault', { provider: connection.name });
      return [customModelOptionId({ connectionId: connection.id, modelId: model.id }), {
        name,
        shortName: model.id && name !== connection.name ? `${name} · ${connection.name}` : name,
        groupLabel: translate('customModels.title'), providerLabel: connection.name,
        icon: modelProviderIcon(preset ? { id: preset.id, name: preset.name, iconKey: preset.icon } : null),
        description: `${connection.name} · ${actual}`,
        ...(reason ? { disabled: true, disabledReason: reason } : {}),
        ...('contextWindow' in model && model.contextWindow ? { modelFeatures: { contextWindowSize: model.contextWindow } } : {}),
        ...('maxOutput' in model && model.maxOutput ? { facts: [{ label: translate('customModels.output'), value: model.maxOutput.toLocaleString() }] } : {}),
      } satisfies ComposerModelOption];
    });
  }));
}
