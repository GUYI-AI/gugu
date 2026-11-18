import { useState } from 'react';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { useReplica } from '@/lib/replica';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { customModelOptionId, customModelRefFromOption } from '@gugu/session-core/models/custom-model';
import { autoReviewModelOptions } from '@gugu/session-core/models/auto-review-model';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SessionTitleModelRow } from '@renderer/features/settings/components/SessionSettingsRows';
import { SettingValue } from '@renderer/features/settings/components/SettingControls';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives';

export function AuxiliaryModelsGroup() {
  const { translate } = useSessionMessages();
  const [failure, setFailure] = useState('');
  const models = useReplica(customModels, [null]);
  const reviewer = useAppSettingsKey('autoReviewModel');
  const options = models.state === 'value' ? autoReviewModelOptions(models.value) : null;
  const preference = reviewer.settings.state === 'value' ? reviewer.settings.value.value : null;
  return <SettingsGroup className="gg-auxiliary-models" data-testid="settings-auxiliary-models"
    title={translate('customModels.auxiliaryTitle')} note={translate('customModels.auxiliaryDescription')}>
    <SessionTitleModelRow auxiliary />
    <SettingsRow title={<span className="flex items-center gap-2">{translate('customModels.reviewerModel')}
      <InfoTooltip label={translate('customModels.reviewerModel')} content={translate('customModels.auxiliaryFallback')} />
    </span>} control={<SettingValue reading={reviewer.settings} placeholder="h-8 w-[355px]" onReadAgain={reviewer.refresh}>
      {({ value }) => {
        if (options === null) return <Unknown className="h-8 w-[355px]" />;
        const selected = value && options.find(option => option.connectionId === value.connectionId && option.modelId === value.modelId);
        return <Select value={selected ? customModelOptionId(selected) : '__default__'} disabled={reviewer.isSaving || models.state !== 'value'}
          onValueChange={next => {
            const ref = next === '__default__' ? null : customModelRefFromOption(next);
            if (ref && !ref.modelId) return;
            setFailure('');
            void reviewer.updateAsync(ref ? { ...ref, modelId: ref.modelId! } : null).catch(error => setFailure(errorText(error)));
          }}>
          <SelectTrigger className="gg-auxiliary-model-select" data-testid="auto-review-model"><SelectValue>{selected?.label ?? translate('customModels.defaultRecommended')}</SelectValue></SelectTrigger>
          <SelectContent align="end"><SelectItem value="__default__">{translate('customModels.defaultRecommended')}</SelectItem>
            {options.map(option => <SelectItem key={customModelOptionId(option)} value={customModelOptionId(option)}>
              <span className="flex flex-col"><span>{option.label}</span><span className="text-xs text-muted-foreground">{option.source}</span></span>
            </SelectItem>)}
          </SelectContent>
        </Select>;
      }}
    </SettingValue>} />
    {failure && <SettingsNote tone="danger" role="alert">{failure}</SettingsNote>}
    {models.state !== 'unknown' && <RefreshFailed error={models.error} onRetry={() => { void customModels.refresh(null); }} />}
    {preference && options && !options.some(option => option.connectionId === preference.connectionId && option.modelId === preference.modelId)
      && <SettingsNote>{translate('customModels.auxiliaryFallback')}</SettingsNote>}
  </SettingsGroup>;
}
