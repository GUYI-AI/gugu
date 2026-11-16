import { reportHandledError } from '@/lib/errorSummaryReporting';
import { rendererLogger } from '@/lib/log';
import { replica } from '@/lib/replica';
import { events, rpc, rpcOn } from '@renderer/lib/ipc';
import { appSettingsChangedChannel } from '@shared/events/appEvents';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
import { HANDED_OVER_SETTINGS, type HandedOverSetting } from '../../../../../shared/device-preferences';

export type SettingsMeta<K extends AppSettingsKey> = {
  value: AppSettings[K];
  defaults: AppSettings[K];
  overrides: Partial<AppSettings[K]>;
};

const settingsLog = rendererLogger('settings');

/** This device's host is `local`; another machine's settings (#6264, machine-scoped rows) are keyed by its device id. */
export const LOCAL_SETTINGS_HOST_KEY = 'local';

/**
 * The keys a surface draws from the first frame. Not kept: keys no surface draws (`keyboard`, `browserPreview`), the
 * device preferences preload hands over — their first value is that handover (`local` below), which a snapshot of the
 * last run could contradict — and `browser`, whose profiles have no upper bound (it would outgrow the entry's limit and
 * be refused at every write: review B1-3).
 */
const CARRIED_KEYS: ReadonlySet<AppSettingsKey> = new Set<AppSettingsKey>([
  'terminal', 'sessions', 'defaultAgent', 'newSessionMemory', 'changesViewMode', 'localProject', 'project',
  'notifications', 'openIn', 'resourceMonitor',
]);

/** Desktop: what preload handed over before the first frame (shared/device-preferences.ts); web / phone: nothing. */
const handover = typeof window === 'undefined' ? null : window.guguDeviceSettings?.handover ?? null;
const handedOver = (key: AppSettingsKey): key is HandedOverSetting => (HANDED_OVER_SETTINGS as readonly string[]).includes(key);

/**
 * @@@app-settings-read-model — one entry per settings key of this device, all read once at startup
 * (`prefetchAllAppSettings`); the drawn keys are kept in the device snapshot so the first frame after a restart has the
 * stored values, never the schema defaults. Changes elsewhere re-read the key (`watchAppSettingsChanges`).
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
  // Handed-over keys start from main's answer to preload (what the boot script painted with).
  local: (_device, key: AppSettingsKey, host: string) =>
    host === LOCAL_SETTINGS_HOST_KEY && handover && handedOver(key) ? handover.settings[key] as SettingsMeta<AppSettingsKey> : undefined,
  // Largest carried key: `sessions` 1,204 with every field used. One entry per key.
  persist: {
    maxBytes: 1536,
    maxEntries: 12,
    // Web (no handover): `interface` keeps its first frame from the snapshot.
    carry: (meta: SettingsMeta<AppSettingsKey>, key: AppSettingsKey, host: string) =>
      (host === LOCAL_SETTINGS_HOST_KEY && (CARRIED_KEYS.has(key) || (!handover && key === 'interface')) ? meta : undefined),
  },
});

type SettingsRpc = Pick<ReturnType<typeof rpcOn>, 'appSettings'>;
let remoteSettingsRoute: (host: string) => SettingsRpc = (host) => rpcOn(host);

/** The phone has no machine client (`rpcOn`): its shell routes through its session-page channel (projectRpc.ts). */
export function routeRemoteSettings(route: (host: string) => SettingsRpc): void {
  remoteSettingsRoute = route;
}

/** Another machine's settings (#6264): ❌ persisted — they would push this device's keys out of the snapshot. */
export const remoteAppSettingsModel = replica({
  name: 'remoteAppSettings',
  scope: 'account',
  read: async (_device, key: AppSettingsKey, host: string) => await remoteSettingsRoute(host).appSettings.getWithMeta(key) as SettingsMeta<AppSettingsKey>,
  fresh: 5 * 60_000,
});

export function settingsModelOf(host: string): typeof appSettingsModel {
  return host === LOCAL_SETTINGS_HOST_KEY ? appSettingsModel : remoteAppSettingsModel;
}

let startupRead: Promise<void> | null = null;

/** Startup: the whole local set in one read, once per document; a failed read is tried again by the next caller. */
export function prefetchAllAppSettings(): Promise<void> {
  watchAppSettingsChanges();
  startupRead ??= (async () => {
    const all = await rpc.appSettings.getAll() as { [K in AppSettingsKey]: SettingsMeta<K> };
    for (const key of Object.keys(all) as AppSettingsKey[]) appSettingsModel.set([key, LOCAL_SETTINGS_HOST_KEY], all[key]);
  })().catch((error: unknown) => {
    startupRead = null;
    throw error;
  });
  return startupRead;
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
 * Follow changes made elsewhere. A key this window is writing is left alone: its write settles with its own read (I4 —
 * a read landing mid-edit would put an older value over the newer one being typed).
 */
export function watchAppSettingsChanges(): void {
  if (watching) return;
  watching = events.on(appSettingsChangedChannel, ({ key }) => {
    if (pendingWrites.has(key)) return;
    invalidateAppSettingsKey(key);
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

/**
 * The one write of a settings key (this device's, or another machine's by its host key): drawn at once, held against this
 * window's own broadcast (`beginAppSettingsWrite`), put back when main refuses (the refusal reaches the caller), and read
 * again when it settles either way — the broadcasts dropped meanwhile may have carried another window's change (I4).
 */
export function writeAppSetting<K extends AppSettingsKey>(key: K, value: AppSettings[K], host = LOCAL_SETTINGS_HOST_KEY): Promise<void> {
  const reading = settingsModelOf(host).peek(key, host);
  if (reading.state !== 'value') throw new Error(`settings ${key}: not read yet`);
  const prev = (reading.value as SettingsMeta<K>).value;
  const done = host === LOCAL_SETTINGS_HOST_KEY ? beginAppSettingsWrite(key) : () => {};
  setAppSettingsValueInCache(key, value, host);
  return updateAppSettingsRequest(key, value, host)
    .catch((error: unknown) => {
      setAppSettingsValueInCache(key, prev, host);
      settingsLog.error({ key, error: String(error) }, `settings ${key}: main refused the write; the shown value is put back`);
      throw error;
    })
    .finally(() => {
      done();
      invalidateAppSettingsKey(key, host);
    });
}

/** Read a key again, even with no surface showing it: logic outside React decides on these values (`getAppSettingValueSnapshot`). */
export function invalidateAppSettingsKey<K extends AppSettingsKey>(key: K, host = LOCAL_SETTINGS_HOST_KEY): void {
  const model = settingsModelOf(host);
  void model.refresh(key, host).then(() => model.prefetch(key, host));
}
