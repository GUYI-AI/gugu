import { useEffect, useState } from 'react';
import { platform } from '@/platform';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { useReplica } from '@/lib/replica';
import { RefreshFailed } from '@/components/ui/RefreshFailed';
import { Unknown } from '@/components/ui/Unknown';
import { customModels } from '@renderer/features/sessions/session-config/custom-models';
import { customModelOptionId } from '@gugu/session-core/models/custom-model';
import { autoReviewModelOptions, platformAutoReviewModelOptions, type AutoReviewModel } from '@gugu/session-core/models/auto-review-model';
import { platformModels } from '@/lib/agentModelReplicas';
import { followSettingsFocus } from './settings-focus';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SessionTitleModelRow } from '@renderer/features/settings/components/SessionSettingsRows';
import { SettingValue } from '@renderer/features/settings/components/SettingControls';
import { InfoTooltip } from '@renderer/lib/ui/info-tooltip';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SettingsGroup, SettingsNote, SettingsRow } from './SettingsPrimitives';

export function AuxiliaryModelsGroup() {
  return platform.capabilities.modelSettings ? <AvailableAuxiliaryModelsGroup /> : null;
}

const PLATFORM_PREFIX = 'platform:';
type ReviewerOption = { value: string; label: string; source: string; preference: NonNullable<AutoReviewModel> };

function sameReviewer(a: AutoReviewModel, b: AutoReviewModel): boolean {
  if (!a || !b || a.kind !== b.kind || a.modelId !== b.modelId) return false;
  return a.kind === 'platform' || (b.kind === 'custom' && a.connectionId === b.connectionId);
}

function AvailableAuxiliaryModelsGroup() {
  const { translate } = useSessionMessages();
  const [failure, setFailure] = useState('');
  const models = useReplica(customModels, [null]);
  const catalog = useReplica(platformModels, []);
  const reviewer = useAppSettingsKey('autoReviewModel');
  // Opened from a greyed Auto mode ("choose a review model"): bring this row into view and focus its picker.
  useEffect(() => followSettingsFocus('review-model', () => requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>('[data-settings-anchor="review-model"]');
    row?.scrollIntoView({ block: 'center' });
    row?.querySelector<HTMLElement>('[data-testid="auto-review-model"]')?.focus();
  })), []);
  // Gugu's models that can review (they review Gugu-model sessions, on credits): not known until the catalog is read;
  // a catalog that cannot be read offers none of them and says so under the row (RefreshFailed below).
  const platformOptions: ReviewerOption[] | null = catalog.state === 'unknown' ? null
    : catalog.state === 'error' ? []
    : platformAutoReviewModelOptions(catalog.value).map(option => ({
      value: `${PLATFORM_PREFIX}${option.modelId}`, label: option.label, source: translate('customModels.reviewerPlatformSource'),
      preference: { kind: 'platform' as const, modelId: option.modelId },
    }));
  // Then the user's connection models.
  const options: ReviewerOption[] | null = models.state === 'value' && platformOptions !== null ? [
    ...platformOptions,
    ...autoReviewModelOptions(models.value).map(option => ({
      value: customModelOptionId(option), label: option.label, source: option.source,
      preference: { kind: 'custom' as const, connectionId: option.connectionId, modelId: option.modelId },
    })),
  ] : null;
  const preference = reviewer.settings.state === 'value' ? reviewer.settings.value.value : null;
  // A stored pick no longer listed (a removed connection, a model the catalog dropped) stays visible, named as such.
  const stale = preference && options && !options.some(option => sameReviewer(option.preference, preference)) ? preference : null;
  return <SettingsGroup className="gg-auxiliary-models" data-testid="settings-auxiliary-models"
    title={translate('customModels.auxiliaryTitle')} note={translate('customModels.auxiliaryDescription')}>
    <SessionTitleModelRow auxiliary />
    <SettingsRow data-settings-anchor="review-model" title={<span className="flex items-center gap-2">{translate('customModels.reviewerModel')}
      <InfoTooltip label={translate('customModels.reviewerModel')} content={translate('customModels.reviewerHint')} />
    </span>} control={<SettingValue reading={reviewer.settings} placeholder="h-8 w-[355px]">
      {({ value }) => {
        if (options === null) return <Unknown className="h-8 w-[355px]" />;
        const selected = value ? options.find(option => sameReviewer(option.preference, value)) : undefined;
        const current = selected?.value ?? (value ? '__stale__' : '__default__');
        return <Select value={current} disabled={reviewer.isSaving}
          onValueChange={next => {
            if (next === '__stale__') return;
            const picked = next === '__default__' ? null : options.find(option => option.value === next)?.preference;
            if (picked === undefined) return;
            setFailure('');
            void reviewer.updateAsync(picked).catch(error => setFailure(errorText(error)));
          }}>
          <SelectTrigger className="gg-auxiliary-model-select" data-testid="auto-review-model"><SelectValue>
            {selected?.label ?? (value ? value.modelId : translate('customModels.defaultRecommended'))}
          </SelectValue></SelectTrigger>
          <SelectContent align="end"><SelectItem value="__default__">{translate('customModels.defaultRecommended')}</SelectItem>
            {value && !selected && <SelectItem value="__stale__" disabled>
              <span className="flex flex-col"><span>{value.modelId}</span><span className="text-xs text-muted-foreground">{translate('customModels.reviewerStale')}</span></span>
            </SelectItem>}
            {options.map(option => <SelectItem key={option.value} value={option.value}>
              <span className="flex flex-col"><span>{option.label}</span><span className="text-xs text-muted-foreground">{option.source}</span></span>
            </SelectItem>)}
          </SelectContent>
        </Select>;
      }}
    </SettingValue>} />
    {failure && <SettingsNote tone="danger" role="alert">{failure}</SettingsNote>}
    {models.state !== 'unknown' && <RefreshFailed reading={models} />}
    {catalog.state !== 'unknown' && <RefreshFailed reading={catalog} />}
    {stale && <SettingsNote>{translate('customModels.reviewerUnavailable')}</SettingsNote>}
  </SettingsGroup>;
}
