import { isDeepEqual } from '@gugu/session-shared';
import type { IInitializable } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { appSettings } from '@main/db/schema';
import { AppSettingsKeys, type AppSettings, type AppSettingsKey } from '@shared/core/app-settings';
import { APP_SETTINGS_SCHEMA_MAP } from './schema';
import { getDefaultForKey } from './settings-registry';
import { computeDelta, computeTrueOverrides, isPlainObject, mergeDeep } from './utils';
import { migratedNotificationSettings } from './notification-settings';

export type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
export { AppSettingsKeys } from '@shared/core/app-settings';

export type SettingsMeta<K extends AppSettingsKey> = {
  value: AppSettings[K];
  defaults: AppSettings[K];
  overrides: Partial<AppSettings[K]>;
};

export class SettingsStore implements IInitializable {
  private cache: Partial<AppSettings> = {};

  /** Synchronous underneath (better-sqlite3): preload's handover reads and adopts through these before the first frame. */
  readRaw(key: AppSettingsKey): unknown {
    const [row] = db.select().from(appSettings).where(eq(appSettings.key, key)).all();
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(row.value);
      return key === 'keyboard' ? APP_SETTINGS_SCHEMA_MAP.keyboard.parse(value) : value;
    } catch {
      return null;
    }
  }

  private storeRaw(key: AppSettingsKey, value: unknown): void {
    const serialized = JSON.stringify(value);
    db
      .insert(appSettings)
      .values({ key, value: serialized })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } })
      .run();
  }

  private deleteRow(key: AppSettingsKey): void {
    db.delete(appSettings).where(eq(appSettings.key, key)).run();
  }

  async get<K extends AppSettingsKey>(key: K): Promise<AppSettings[K]> {
    if (key in this.cache) return this.cache[key] as AppSettings[K];

    const defaults = getDefaultForKey(key);
    const raw = this.readRaw(key);

    let value: AppSettings[K];
    if (raw === null || raw === undefined) {
      value = defaults;
    } else if (isPlainObject(raw) && isPlainObject(defaults)) {
      value = mergeDeep(defaults as Record<string, unknown>, raw) as AppSettings[K];
    } else {
      value = raw as AppSettings[K];
    }

    this.cache[key] = value;
    return value;
  }

  async getWithMeta<K extends AppSettingsKey>(key: K): Promise<SettingsMeta<K>> {
    return this.getWithMetaNow(key);
  }

  getWithMetaNow<K extends AppSettingsKey>(key: K): SettingsMeta<K> {
    const defaults = getDefaultForKey(key);
    const raw = this.readRaw(key);

    if (raw === null || raw === undefined) {
      return { value: defaults, defaults, overrides: {} as Partial<AppSettings[K]> };
    }

    let value: AppSettings[K];
    let overrides: Partial<AppSettings[K]>;

    if (isPlainObject(raw) && isPlainObject(defaults)) {
      value = mergeDeep(defaults as Record<string, unknown>, raw) as AppSettings[K];
      overrides = computeTrueOverrides(raw, defaults as Record<string, unknown>) as Partial<
        AppSettings[K]
      >;
    } else {
      value = raw as AppSettings[K];
      overrides = (isDeepEqual(raw, defaults) ? {} : raw) as Partial<AppSettings[K]>;
    }

    return { value, defaults, overrides };
  }

  async update<K extends AppSettingsKey>(key: K, value: AppSettings[K]): Promise<void> {
    this.updateNow(key, value);
  }

  updateNow<K extends AppSettingsKey>(key: K, value: AppSettings[K]): void {
    const validated = APP_SETTINGS_SCHEMA_MAP[key].parse(value) as AppSettings[K];
    const defaults = getDefaultForKey(key);

    if (isPlainObject(validated) && isPlainObject(defaults)) {
      const delta = computeDelta(
        validated as Record<string, unknown>,
        defaults as Record<string, unknown>
      );
      if (Object.keys(delta).length === 0) {
        this.deleteRow(key);
      } else {
        this.storeRaw(key, delta);
      }
    } else if (isDeepEqual(validated, defaults)) {
      this.deleteRow(key);
    } else {
      this.storeRaw(key, validated);
    }

    delete this.cache[key];
  }

  async reset<K extends AppSettingsKey>(key: K): Promise<void> {
    this.deleteRow(key);
    delete this.cache[key];
  }

  async resetField<K extends AppSettingsKey>(key: K, field: keyof AppSettings[K]): Promise<void> {
    const raw = this.readRaw(key);
    if (!isPlainObject(raw)) return;

    const delta = { ...raw };
    delete delta[field as string];

    if (Object.keys(delta).length === 0) {
      this.deleteRow(key);
    } else {
      this.storeRaw(key, delta);
    }
    delete this.cache[key];
  }

  async getAll(): Promise<AppSettings> {
    const entries = await Promise.all(
      AppSettingsKeys.map(async (key) => [key, await this.get(key)] as const)
    );
    return Object.fromEntries(entries) as AppSettings;
  }

  async initialize(): Promise<void> {
    const notifications = migratedNotificationSettings(this.readRaw('notifications'));
    // update validates and replaces the raw delta, so mergeDeep cannot retain legacy keys.
    if (notifications) await this.update('notifications', notifications);
    await this.getAll();
  }
}

export const appSettingsService = new SettingsStore();
