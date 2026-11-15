import { reportHandledError } from '@/lib/errorSummaryReporting';
import { replica } from '@/lib/replica';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { appSettingsChangedChannel } from '@shared/events/appEvents';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';

export type SettingsMeta<K extends AppSettingsKey> = {
  value: AppSettings[K];
  defaults: AppSettings[K];
  overrides: Partial<AppSettings[K]>;
};

/** This device's host is `local`; another machine's settings (#6264, machine-scoped rows) are keyed by its device id. */
export const LOCAL_SETTINGS_HOST_KEY = 'local';

/**
 * The keys a surface draws from the first frame (the task page's composer, sidebar, sessions panel, terminal, changes
 * panel, project creation) and the Settings pages accepted in PR 2. Keys no surface draws (`keyboard` only binds
 * shortcuts and grows with rebinds; `theme`, `browserPreview` have no renderer reader) are read at startup, not kept.
 */
const CARRIED_KEYS: ReadonlySet<AppSettingsKey> = new Set<AppSettingsKey>([
  'interface', 'terminal', 'sessions', 'defaultAgent', 'newSessionMemory', 'changesViewMode', 'localProject', 'project',
  'notifications', 'browser', 'openIn', 'resourceMonitor',
]);

/**
 * @@@app-settings-read-model — every settings key of this device is one entry of this model. The whole set is read once
 * at startup (`prefetchAllAppSettings`, one IPC); the keys surfaces draw are kept in this device's snapshot, so the first
 * frame after a restart has the stored values, never the schema defaults. A change from any window or the main process
 * arrives as `appSettingsChangedChannel` and the key is read again (`watchAppSettingsChanges`).
 */
export const appSettingsModel = replica({
  name: 'appSettings',
  scope: 'device',
  read: async (_device, key: AppSettingsKey, _host: string) => {
    try {
      return await rpc.appSettings.getWithMeta(key) as SettingsMeta<AppSettingsKey>;
    } catch (error) {
      reportHandledError(error, 'settings.read');
      throw error;
    }
  },
  fresh: 5 * 60_000,
  // `sessions` is the largest carried key: 1,204 with every field used (a 200-character title instruction); `browser`
  // grows with profiles (1,246 at 8). One entry per carried key.
  persist: {
    maxBytes: 1536,
    maxEntries: 12,
    carry: (meta: SettingsMeta<AppSettingsKey>, key: AppSettingsKey, host: string) => (host === LOCAL_SETTINGS_HOST_KEY && CARRIED_KEYS.has(key) ? meta : undefined),
  },
});

/**
 * Another machine's settings (#6264, machine-scoped rows): read when its Settings page shows them, ❌ kept across
 * restarts (they would push this device's keys out of the snapshot) — that page draws placeholders on a cold open.
 */
export const remoteAppSettingsModel = replica({
  name: 'remoteAppSettings',
  scope: 'device',
  read: async (_device, key: AppSettingsKey, host: string) => await rpcOn(host).appSettings.getWithMeta(key) as SettingsMeta<AppSettingsKey>,
  fresh: 5 * 60_000,
});

export function settingsModelOf(host: string): typeof appSettingsModel {
  return host === LOCAL_SETTINGS_HOST_KEY ? appSettingsModel : remoteAppSettingsModel;
}

/** Startup: the whole local set in one read, before the first frame of either entry. */
export async function prefetchAllAppSettings(): Promise<void> {
  watchAppSettingsChanges();
  const all = await rpc.appSettings.getAll() as { [K in AppSettingsKey]: SettingsMeta<K> };
  for (const key of Object.keys(all) as AppSettingsKey[]) appSettingsModel.set([key, LOCAL_SETTINGS_HOST_KEY], all[key]);
}

/** Writes of this window still on their way, per key: their own broadcast must not read a key back over a newer edit. */
const pendingWrites = new Map<AppSettingsKey, number>();

export function beginAppSettingsWrite(key: AppSettingsKey): () => void {
  pendingWrites.set(key, (pendingWrites.get(key) ?? 0) + 1);
  return () => {
    const left = (pendingWrites.get(key) ?? 1) - 1;
    if (left > 0) pendingWrites.set(key, left);
    else pendingWrites.delete(key);
  };
}

let watching: (() => void) | null = null;

/**
 * Follow changes made elsewhere (another window, the main process). A key this window is writing is left alone: its
 * write settles with a read of its own (I4 — the write is a layer; a read landing mid-edit would put an older value
 * over the newer one being typed).
 */
export function watchAppSettingsChanges(): void {
  if (watching) return;
  watching = events.on(appSettingsChangedChannel, ({ key }) => {
    if (pendingWrites.has(key)) return;
    // Read even with no surface showing it: logic outside React decides on these values (`getAppSettingValueSnapshot`).
    void appSettingsModel.refresh(key, LOCAL_SETTINGS_HOST_KEY).then(() => appSettingsModel.prefetch(key, LOCAL_SETTINGS_HOST_KEY));
  });
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
  settingsModelOf(host).set([key, host], (old: SettingsMeta<AppSettingsKey> | undefined) => old && { ...old, value } as SettingsMeta<AppSettingsKey>);
}

export function updateAppSettingsRequest<K extends AppSettingsKey>(key: K, value: AppSettings[K], host = LOCAL_SETTINGS_HOST_KEY): Promise<void> {
  return (host === LOCAL_SETTINGS_HOST_KEY ? rpc : rpcOn(host)).appSettings.update(key, value as never) as Promise<void>;
}

export function invalidateAppSettingsKey<K extends AppSettingsKey>(key: K, host = LOCAL_SETTINGS_HOST_KEY): void {
  void settingsModelOf(host).refresh(key, host);
}
