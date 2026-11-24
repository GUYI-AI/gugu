import { useReplica } from '@/lib/replica';
import { appSettingsModel, LOCAL_SETTINGS_HOST_KEY, writeAppSetting, type SettingsMeta } from '@renderer/features/settings/app-settings-client';
import { contextThresholdKey, supportsContextThreshold } from '@gugu/session-core/models/context-threshold';
import type { ComposerContextThresholds } from '@gugu/session-ui/react/components';

export function useContextThresholds(harness: string | null | undefined, machine: string | null | undefined): ComposerContextThresholds {
  const host = machine ?? LOCAL_SETTINGS_HOST_KEY;
  const reading = useReplica(appSettingsModel, harness && supportsContextThreshold(harness) ? ['contextThresholds', host] : null);
  return (model, maximum) => {
    if (!harness || !maximum) return undefined;
    if (!supportsContextThreshold(harness)) return { maximum, value: null, unsupported: true };
    if (reading.state !== 'value') return undefined;
    const key = contextThresholdKey(harness, model);
    const stored = (reading.value as SettingsMeta<'contextThresholds'>).value[key];
    return {
      maximum,
      value: stored && stored.tokens < maximum ? stored.tokens : null,
      set: async (value) => {
        const latest = appSettingsModel.peek('contextThresholds', host);
        if (latest.state !== 'value') throw new Error('Context thresholds are unavailable');
        const previous = (latest.value as SettingsMeta<'contextThresholds'>).value;
        const next = { ...previous };
        if (value === null) delete next[key];
        else next[key] = { tokens: value, maximum };
        await writeAppSetting('contextThresholds', next, host);
      },
    };
  };
}
