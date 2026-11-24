import { customModelApiUrl, customModelOptionId, matchCustomModel, type CustomModelConnection, type ModelProtocol } from '@gugu/session-core/models/custom-model';
import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { providerPresets } from '@gugu/session-core/models/provider-presets';
import { getDomainWithoutSuffix } from 'tldts';
import { vendorName } from '@/i18n/vendorName';
import { modelProviderIcon } from './model-provider-icon';

/** Codex uses settings-managed entries. An imported Claude API connection also replaces its native catalog. */
export function managedHarnessOptions(
  options: Record<string, ComposerModelOption> | null,
  providerId: string | null | undefined,
  connections: readonly CustomModelConnection[] | undefined,
): Record<string, ComposerModelOption> | null {
  if (providerId === 'codex') return null;
  if (providerId === 'claude' && connections?.some(connection => connection.managedNativeHarnesses?.includes('claude'))) return null;
  return options;
}

export function customComposerOptions(
  connections: readonly CustomModelConnection[], agent: (Pick<AgentPayload, 'id' | 'name'> & { capabilities: Pick<AgentPayload['capabilities'], 'modelProtocols' | 'customModel'> }) | undefined,
  device: string, translate: ReturnType<typeof useSessionMessages>['translate'],
): Record<string, ComposerModelOption> {
  const protocols = agent?.capabilities.modelProtocols ?? [];
  const protocolName = (protocol: ModelProtocol) => translate(`customModels.${protocol}`);
  const sources = connections.filter(connection => !connection.keyConflict &&
    (connection.models.length || (!connection.discovered && !connection.disabledModels?.length))).map(connection => {
    const url = customModelApiUrl(connection);
    const preset = providerPresets.find(({ id }) => id === connection.preset);
    const label = preset ? vendorName(preset.name) : connection.name || new URL(url).host;
    return { connection, url, preset, label };
  });
  const labelCounts = new Map<string, number>();
  for (const { label } of sources) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  return Object.fromEntries(sources.flatMap(({ connection, url, preset, label }) => {
    const groupLabel = (labelCounts.get(label) ?? 0) > 1 ? `${label} · ${url.replace(/^https?:\/\//, '')}` : label;
    const entries = connection.models.length ? connection.models : [{ id: undefined }];
    return entries.map((model) => {
      const matched = matchCustomModel({ connection, harness: agent?.id, nativeProtocol: protocols[0], protocols, convertFrom: agent?.capabilities.customModel?.convertFrom,
        hasModel: Boolean(model.id), allowDefaultModel: agent?.capabilities.customModel?.modelOptional });
      const required = protocols.map(protocolName).join(' / ');
      const actual = connection.endpoints.map(({ protocol }) => protocolName(protocol)).join(' / ');
      const reason = matched.reason === 'unsupported' ? translate('customModels.unsupported', { harness: agent?.name ?? '' })
        : matched.reason === 'missing-key' ? translate('customModels.missingKey', { device })
          : matched.reason === 'no-model' ? translate('customModels.noModel')
            : matched.reason === 'protocol' ? translate(connection.preset ? 'customModels.protocolPreset' : 'customModels.protocolCustom', { harness: agent?.name ?? '', required, actual, provider: connection.name }) : undefined;
      const name = model.id ? ('label' in model && model.label || model.id) : translate('customModels.cliDefault', { provider: connection.name });
      return [customModelOptionId({ connectionId: connection.id, modelId: model.id }), {
        name,
        groupId: `connection:${connection.id}`,
        groupLabel,
        providerLabel: getDomainWithoutSuffix(url) || label,
        icon: modelProviderIcon(preset ? { id: preset.id, name: preset.name, iconKey: preset.icon } : null),
        description: url,
        ...(reason ? { disabled: true, disabledReason: reason } : {}),
        ...('contextWindow' in model && model.contextWindow ? { modelFeatures: { contextWindowSize: model.contextWindow } } : {}),
        ...('maxOutput' in model && model.maxOutput ? { facts: [{ label: translate('customModels.output'), value: model.maxOutput.toLocaleString() }] } : {}),
      } satisfies ComposerModelOption];
    });
  }));
}
