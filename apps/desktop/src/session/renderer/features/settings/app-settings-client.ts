import { reportHandledError } from '@/lib/errorSummaryReporting';
import { rendererLogger } from '@/lib/log';
import { replica } from '@/lib/replica';
import { writeOver } from '@/lib/replicaWrite';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { newSessionMemoryChangedChannel } from '@shared/core/sessions/sessionEvents';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';

export type SettingsMeta<K extends AppSettingsKey> = {
  value: AppSettings[K];
  defaults: AppSettings[K];
  overrides: Partial<AppSettings[K]>;
};

const settingsLog = rendererLogger('settings');

/** This device's host is `local`; another machine's settings (#6264, machine-scoped rows) are keyed by its device id. */
export const LOCAL_SETTINGS_HOST_KEY = 'local';

/**
 * @@@app-settings-read-model — every settings key of every host is one entry of this model. The whole local set is
 * read once at startup (`prefetchAllAppSettings`, one IPC) and kept as this device's snapshot, so a settings surface
 * opened at any time — the first frame after a restart included — has the stored values, never the schema defaults.
 */
export const appSettingsModel = replica({
  name: 'appSettings',
  scope: 'device',
  read: async (_device, key: AppSettingsKey, host: string) => {
    try {
      return await settingsRpcOn(host).getWithMeta(key) as SettingsMeta<AppSettingsKey>;
    } catch (error) {
      if (host === LOCAL_SETTINGS_HOST_KEY) reportHandledError(error, 'settings.read');
      throw error;
    }
  },
  fresh: 5 * 60_000,
  // The browser page's settings recover a transient failure before saying it; every other key fails loud at once.
  retry: (failures: number, _error: Error, key: AppSettingsKey) => key === 'browser' && failures < 3,
  persist: { maxBytes: 1024, maxEntries: 30 },
});

type SettingsRpc = Pick<ReturnType<typeof rpcOn>, 'appSettings'>;
let remoteSettingsRoute: (host: string) => SettingsRpc = (host) => rpcOn(host);

/** The phone has no machine client (`rpcOn`): it routes through its session-page channel. */
export function routeRemoteSettings(route: (host: string) => SettingsRpc): void {
  remoteSettingsRoute = route;
}

/** The one route to a host's settings: reads, writes and resets all go through it (❌ a write on another pipe than its read). */
export function settingsRpcOn(host: string): SettingsRpc['appSettings'] {
  return (host === LOCAL_SETTINGS_HOST_KEY ? rpc : remoteSettingsRoute(host)).appSettings;
}

let startupRead: Promise<void> | null = null;

/** Once per document; a failed read is tried again by the next caller. */
export function prefetchAllAppSettings(): Promise<void> {
  startupRead ??= (async () => {
    const all = await rpc.appSettings.getAll() as { [K in AppSettingsKey]: SettingsMeta<K> };
    for (const key of Object.keys(all) as AppSettingsKey[]) appSettingsModel.set([key, LOCAL_SETTINGS_HOST_KEY], all[key]);
  })().catch((error: unknown) => {
    startupRead = null;
    throw error;
  });
  return startupRead;
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
  appSettingsModel.set([key, host], (old: SettingsMeta<AppSettingsKey> | undefined) => old && { ...old, value } as SettingsMeta<AppSettingsKey>);
}

export function updateAppSettingsRequest<K extends AppSettingsKey>(key: K, value: AppSettings[K], host = LOCAL_SETTINGS_HOST_KEY): Promise<void> {
  return settingsRpcOn(host).update(key, value as never) as Promise<void>;
}

/** The one write of a settings key; read again when it settles. */
export async function writeAppSetting<K extends AppSettingsKey>(key: K, value: AppSettings[K], host = LOCAL_SETTINGS_HOST_KEY): Promise<void> {
  try {
    await writeOver(appSettingsModel, [key, host], (old) => old && { ...old, value } as SettingsMeta<AppSettingsKey>,
      () => updateAppSettingsRequest(key, value, host));
  } catch (error) {
    settingsLog.error({ key, error: String(error) }, `settings ${key}: main refused the write; the stored value is shown again`);
    throw error;
  } finally {
    invalidateAppSettingsKey(key, host);
  }
}

/** Even with no surface showing it: logic outside React decides on these values. */
export function invalidateAppSettingsKey<K extends AppSettingsKey>(key: K, host = LOCAL_SETTINGS_HOST_KEY): void {
  void appSettingsModel.reread(key, host).catch(() => undefined);
}

/** Main writes the new-session memory itself after a switched model's first reply (#3293): the box reads it fresh. */
export function wireNewSessionMemoryRefresh(): void {
  events.on(newSessionMemoryChangedChannel, () => invalidateAppSettingsKey('newSessionMemory'));
}
