import { useState } from 'react';
import { platform } from '@/platform';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { useReplica } from '@/lib/replica';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { customModelOptionId, customModelRefFromOption, type CustomModelConnection } from '@gugu/session-core/models/custom-model';
import { autoReviewModelOptions } from '@gugu/session-core/models/auto-review-model';
import { customClaudeReviewSource } from '@gugu/session-core/models/auto-review-source';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SessionTitleModelRow } from '@renderer/features/settings/components/SessionSettingsRows';
import { SettingValue } from '@renderer/features/settings/components/SettingControls';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives';

type ReviewerOption = ReturnType<typeof autoReviewModelOptions>[number];

/**
 * The row an unset preference (`null`) resolves to, when it is one concrete model on every connection that offers a
 * reviewer: packages/session-core/src/models/auto-review-source.ts:7-24 with `preference: null`. Settings has no
 * session, so no conversation model goes in. Only the official endpoint (:16-18) still names a model; a `byHaiku` or
 * `platform-fallback` answer means the connection reaches the conversation-model step (:19-23) — same as the chat model.
 */
function unsetReviewerOption(connections: readonly CustomModelConnection[], options: readonly ReviewerOption[]) {
  const resolved = new Set<string>();
  for (const connection of connections) {
    const endpoint = connection.endpoints.find(entry => entry.protocol === 'anthropic-messages');
    if (!endpoint || !options.some(option => option.connectionId === connection.id)) continue;
    const source = customClaudeReviewSource({ connectionId: connection.id, endpoint: endpoint.baseUrl, models: connection.models, preference: null });
    if (source.kind !== 'own' || source.byHaiku) return undefined;
    resolved.add(source.modelId);
  }
  const [modelId, ...others] = resolved;
  return modelId && !others.length ? options.find(option => option.modelId === modelId) : undefined;
}

export function AuxiliaryModelsGroup() {
  return platform.capabilities.modelSettings ? <AvailableAuxiliaryModelsGroup /> : null;
}

function AvailableAuxiliaryModelsGroup() {
  const { translate } = useSessionMessages();
  const [failure, setFailure] = useState('');
  const models = useReplica(customModels, [null]);
  const reviewer = useAppSettingsKey('autoReviewModel');
  const connections = models.state === 'value' ? models.value : null;
  const options = connections && autoReviewModelOptions(connections);
  const preference = reviewer.settings.state === 'value' ? reviewer.settings.value.value : null;
  return <SettingsGroup className="gg-auxiliary-models" data-testid="settings-auxiliary-models"
    title={translate('customModels.auxiliaryTitle')} note={translate('customModels.auxiliaryDescription')}>
    <SessionTitleModelRow auxiliary />
    <SettingsRow title={<span className="flex items-center gap-2">{translate('customModels.reviewerModel')}
      <InfoTooltip label={translate('customModels.reviewerModel')} content={translate('customModels.reviewerFallback')} />
    </span>} control={<SettingValue reading={reviewer.settings} placeholder="h-8 w-[355px]">
      {({ value }) => {
        if (!connections || !options) return <Unknown className="h-8 w-[355px]" />;
        const selected = value && options.find(option => option.connectionId === value.connectionId && option.modelId === value.modelId);
        // As the composer shows its default alias as the concrete model: unset checks the row it resolves to, if any.
        const checked = selected || unsetReviewerOption(connections, options);
        const checkedId = checked ? customModelOptionId(checked) : null;
        return <Select value={checkedId} disabled={reviewer.isSaving}
          onValueChange={next => {
            // Picking the checked row again means "not specified": a chosen model goes back to null, and the row null
            // already resolves to stays null instead of silently becoming a concrete preference.
            const unset = next === checkedId;
            const ref = unset ? null : customModelRefFromOption(next);
            if (unset ? value === null : !ref?.modelId) return;
            setFailure('');
            void reviewer.updateAsync(ref ? { ...ref, modelId: ref.modelId! } : null).catch(error => setFailure(errorText(error)));
          }}>
          <SelectTrigger className="gg-auxiliary-model-select" data-testid="auto-review-model"><SelectValue>{checked?.label ?? translate('customModels.reviewerSameAsChat')}</SelectValue></SelectTrigger>
          <SelectContent align="end">
            {options.map(option => <SelectItem key={customModelOptionId(option)} value={customModelOptionId(option)}>
              <span className="flex flex-col"><span>{option.label}</span><span className="text-xs text-muted-foreground">{option.source}</span></span>
            </SelectItem>)}
          </SelectContent>
        </Select>;
      }}
    </SettingValue>} />
    {failure && <SettingsNote tone="danger" role="alert">{failure}</SettingsNote>}
    {models.state !== 'unknown' && <RefreshFailed reading={models} />}
    {preference && options && !options.some(option => option.connectionId === preference.connectionId && option.modelId === preference.modelId)
      && <SettingsNote>{translate('customModels.reviewerFallback')}</SettingsNote>}
  </SettingsGroup>;
}
