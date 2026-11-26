import { useReplica } from '@/lib/replica';
import { appSettingsModel, LOCAL_SETTINGS_HOST_KEY, writeAppSetting, type SettingsMeta } from '@renderer/features/settings/app-settings-client';
import { contextThresholdForWindow, contextThresholdKey, contextThresholdMinimum, supportsContextThreshold } from '@gugu/session-core/models/context-threshold';
import type { SessionContextChoice } from '@shared/core/sessions/session-config';
import type { ComposerContextThresholds } from '@gugu/session-ui/react/components';

export function useContextThresholds(
  harness: string | null | undefined,
  machine: string | null | undefined,
  choice?: SessionContextChoice,
  select?: (choice: SessionContextChoice, effort?: string) => Promise<void>,
): ComposerContextThresholds {
  const host = machine ?? LOCAL_SETTINGS_HOST_KEY;
  const reading = useReplica(appSettingsModel, harness && supportsContextThreshold(harness) ? ['contextThresholds', host] : null);
  return (model, maximum) => {
    if (!harness || !maximum) return undefined;
    const minimum = contextThresholdMinimum(harness);
    if (!supportsContextThreshold(harness)) return { minimum, maximum, value: null, unsupported: true };
    if (reading.state !== 'value') return undefined;
    const key = contextThresholdKey(harness, model);
    const stored = (reading.value as SettingsMeta<'contextThresholds'>).value[key];
    const write = async (change: (existing: typeof stored) => typeof stored | undefined) => {
      const latest = appSettingsModel.peek('contextThresholds', host);
      if (latest.state !== 'value') throw new Error('Context thresholds are unavailable');
      const previous = (latest.value as SettingsMeta<'contextThresholds'>).value;
      const nextValue = change(previous[key]);
      if (nextValue === previous[key]) return;
      const next = { ...previous };
      if (nextValue) next[key] = nextValue;
      else delete next[key];
      await writeAppSetting('contextThresholds', next, host);
    };
    const selectedWindow = choice?.model === model && choice.window > minimum && choice.window <= maximum ? choice.window : undefined;
    const limit = selectedWindow ?? maximum;
    const tokens = selectedWindow ? contextThresholdForWindow(stored, selectedWindow).tokens : stored?.tokens;
    return {
      minimum, maximum: limit, selectedWindow,
      value: tokens != null && tokens >= minimum && tokens < limit ? tokens : null,
      set: async (value) => {
        if (value !== null && (!Number.isSafeInteger(value) || value < minimum || value >= limit)) {
          throw new Error('Context threshold is out of range');
        }
        await write(() => value === null ? undefined : { tokens: value, maximum });
      },
      selectWindow: select && (async (window, effort) => {
        if (!Number.isSafeInteger(window) || window <= minimum || window > maximum) throw new Error('Context window is out of range');
        await select({ model, window }, effort);
      }),
    };
  };
}
