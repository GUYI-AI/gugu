import { reportHandledError } from '@/lib/errorSummaryReporting';
import { readModel } from '@/lib/readModel';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';

export type SettingsMeta<K extends AppSettingsKey> = {
  value: AppSettings[K];
  defaults: AppSettings[K];
  overrides: Partial<AppSettings[K]>;
};

/** This device's host is `local`; another machine's settings (#6264, machine-scoped rows) are keyed by its device id. */
export const LOCAL_SETTINGS_HOST_KEY = 'local';

/**
 * @@@app-settings-read-model — every settings key of every host is one entry of this model. The whole local set is
 * read once at startup (`prefetchAllAppSettings`, one IPC) and kept as this device's snapshot, so a settings surface
 * opened at any time — the first frame after a restart included — has the stored values, never the schema defaults.
 */
export const appSettingsModel = readModel({
  name: 'appSettings',
  scope: 'device',
  read: async (_device, key: AppSettingsKey, host: string) => {
    try {
      return await (host === LOCAL_SETTINGS_HOST_KEY ? rpc : rpcOn(host)).appSettings.getWithMeta(key) as SettingsMeta<AppSettingsKey>;
    } catch (error) {
      if (host === LOCAL_SETTINGS_HOST_KEY) reportHandledError(error, 'settings.read');
      throw error;
    }
  },
  fresh: 5 * 60_000,
  persist: true,
});

/** Startup: the whole local set in one read, before the first frame of either entry. */
export async function prefetchAllAppSettings(): Promise<void> {
  const all = await rpc.appSettings.getAll() as { [K in AppSettingsKey]: SettingsMeta<K> };
  for (const key of Object.keys(all) as AppSettingsKey[]) appSettingsModel.set([key, LOCAL_SETTINGS_HOST_KEY], all[key]);
}

export function mergeAppSettingsValue<K extends AppSettingsKey>(
  current: AppSettings[K] | undefined,
  partial: Partial<AppSettings[K]>
): AppSettings[K] {
  if (Array.isArray(partial)) {
    return partial as unknown as AppSettings[K];
  }
  if (
    typeof partial === 'object' &&
    partial !== null &&
    typeof current === 'object' &&
    current !== null
  ) {
    return { ...current, ...partial } as AppSettings[K];
  }
  return partial as AppSettings[K];
}

/** The stored value of a local key, for logic outside React; undefined = not read yet (each caller says what that means). */
export function getAppSettingValueSnapshot<K extends AppSettingsKey>(key: K): AppSettings[K] | undefined {
  const reading = appSettingsModel.peek(key, LOCAL_SETTINGS_HOST_KEY);
  return reading.state === 'value' ? (reading.value as SettingsMeta<K>).value : undefined;
}

/** The stored value of a local key, read if needed (logic that must act on the real value, e.g. a default directory). */
export async function fetchAppSettingValue<K extends AppSettingsKey>(key: K): Promise<AppSettings[K]> {
  return ((await appSettingsModel.fetch(key, LOCAL_SETTINGS_HOST_KEY)) as SettingsMeta<K>).value;
}

export function setAppSettingsValueInCache<K extends AppSettingsKey>(key: K, value: AppSettings[K], host = LOCAL_SETTINGS_HOST_KEY): void {
  appSettingsModel.set([key, host], (old) => old && { ...old, value } as SettingsMeta<AppSettingsKey>);
}

export function updateAppSettingsRequest<K extends AppSettingsKey>(key: K, value: AppSettings[K], host = LOCAL_SETTINGS_HOST_KEY): Promise<void> {
  return (host === LOCAL_SETTINGS_HOST_KEY ? rpc : rpcOn(host)).appSettings.update(key, value as never) as Promise<void>;
}

export function invalidateAppSettingsKey<K extends AppSettingsKey>(key: K, host = LOCAL_SETTINGS_HOST_KEY): void {
  void appSettingsModel.refresh(key, host);
}
