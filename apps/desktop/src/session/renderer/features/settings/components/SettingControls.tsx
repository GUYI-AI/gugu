import type { ReactNode } from 'react';
import { Switch } from '@/components/ui/Switch';
import { Unknown } from '@/components/ui/Unknown';
import type { Reading } from '@/lib/replica';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AppSettingsKeyApi } from '../use-app-settings-key';
import { ResetToDefaultButton } from './ResetToDefaultButton';
import { Button } from '@renderer/lib/ui/button';

/**
 * Where a settings value is drawn: the value once read, `<Unknown/>` (sized like the control) before that, the read
 * error when it failed, and the value with a note when only its latest read failed. The one gate every settings control goes through — no control draws a default as the stored value.
 */
export function SettingValue<V>({ reading, placeholder, children, onReadAgain, errorText }: {
  reading: Reading<V>;
  /** Classes sizing the placeholder like the control it stands for. */
  placeholder?: string;
  children: (value: V) => ReactNode;
  onReadAgain?: () => void;
  errorText?: string;
}) {
  const { translate } = useSessionMessages();
  const failure = (refresh: boolean) => {
    const note = <span role="alert" title={refresh ? translate('settings.refreshFailed') : undefined} className="text-xs text-[var(--danger-fg)]">{refresh ? translate('settings.refreshFailed') : errorText || translate('settings.readFailed')}</span>;
    return onReadAgain ? <span className="flex flex-wrap items-center gap-2">{note}<Button size="xs" variant="ghost" onClick={onReadAgain}>{translate('settings.readAgain')}</Button></span> : note;
  };
  // A value whose latest read failed: drawn, and said so (❌ an old value drawn as if it were current).
  if (reading.state === 'value') return reading.error
    ? <>{children(reading.value)}{failure(true)}</>
    : <>{children(reading.value)}</>;
  if (reading.state === 'error') return failure(false);
  return <Unknown className={placeholder} />;
}

type BooleanField<K extends AppSettingsKey> = {
  [F in keyof AppSettings[K]]: AppSettings[K][F] extends boolean ? F : never;
}[keyof AppSettings[K]];

/** A boolean field of a settings key: the reset button and the switch, gated on the read. */
export function SettingSwitch<K extends AppSettingsKey>({ api, field, resetLabel, disabled, label }: {
  api: AppSettingsKeyApi<K>;
  field: BooleanField<K>;
  resetLabel: string;
  disabled?: boolean;
  label?: string;
}) {
  const known = api.settings.state === 'value';
  return (
    <>
      <ResetToDefaultButton
        visible={api.isFieldOverridden(field)}
        defaultLabel={resetLabel}
        onReset={() => api.resetField(field)}
        disabled={!known || api.isSaving || api.unavailable}
      />
      <SettingValue reading={api.settings} placeholder="h-5 w-8 flex-none rounded-[var(--radius-capsule)]">
        {(meta) => (
          <Switch
            checked={(meta.value as Record<string, unknown>)[field as string] === true}
            aria-label={label}
            disabled={api.isSaving || api.unavailable || disabled}
            onCheckedChange={(next) => api.update({ [field]: next } as unknown as Partial<AppSettings[K]>)}
          />
        )}
      </SettingValue>
    </>
  );
}
