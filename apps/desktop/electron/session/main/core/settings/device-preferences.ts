import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { appSettings } from '@main/db/schema';
import { log } from '@main/lib/logger';
import {
  adoptStoredPreferences,
  type DevicePreferences,
  type StoredPreferenceName,
  type StoredPreferenceStrings,
} from '../../../../../shared/device-preferences';
import { getDefaultForKey } from './settings-registry';
import { appSettingsService, type SettingsStore } from './settings-service';
import { isPlainObject } from './utils';

/**
 * @@@device-preferences — main's side (shared/device-preferences.ts): the first-frame answer with the one-time move of the
 * old localStorage keys, and the followers in the host (theme, language, tray badge) told of every change.
 */

const listeners = new Set<(preferences: DevicePreferences) => void>();

export function onDevicePreferencesChanged(listener: (preferences: DevicePreferences) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function devicePreferencesChanged(store: SettingsStore = appSettingsService): void {
  const preferences = store.getWithMetaNow('devicePreferences').value;
  for (const listener of listeners) {
    try {
      listener(preferences);
    } catch (error) {
      log.error('a device preferences follower failed', { error: String(error) });
    }
  }
}

/** The first start has no settings table until its migrations ran: nothing is stored yet. */
function hasSettingsTable(): boolean {
  return db.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).length > 0;
}

/** What the host applies at startup. */
export function devicePreferencesNow(store: SettingsStore = appSettingsService): DevicePreferences {
  return hasSettingsTable() ? store.getWithMetaNow('devicePreferences').value : getDefaultForKey('devicePreferences');
}

/** The move runs once: recorded with the adopted values, in one transaction (keys still there later are only deleted). */
const MOVED_KEY = 'migration.device-preferences-localstorage-v1';

/**
 * Preload's first-frame request: adopt what the old keys hold where main has no value of its own, then answer. A key
 * main cannot read is said and settled (it would be refused again on every start); without a settings table nothing is
 * settled, so the keys stay for the next start. A failed write throws: the caller answers null and the keys stay.
 * Keys that come again after the move (preload's deletion is a localStorage write, lost if the app is killed before it
 * reaches the disk) are settled without being read: a value chosen since then stays.
 */
export function answerDevicePreferences(
  stored: StoredPreferenceStrings,
  store: SettingsStore = appSettingsService
): { devicePreferences: DevicePreferences; settled: StoredPreferenceName[] } {
  if (!hasSettingsTable()) return { devicePreferences: getDefaultForKey('devicePreferences'), settled: [] };
  const sent = Object.keys(stored) as StoredPreferenceName[];
  if (sent.length === 0 || db.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, MOVED_KEY)).all().length > 0) {
    return { devicePreferences: store.getWithMetaNow('devicePreferences').value, settled: sent };
  }
  const raw = store.readRaw('devicePreferences');
  const adoption = adoptStoredPreferences(stored, (field) => isPlainObject(raw) && field in raw);
  for (const name of adoption.unreadable) {
    log.error('an old device preference is unreadable; it is dropped and the setting keeps its value', { name, stored: stored[name] });
  }
  const adopted = Object.keys(adoption.patch).length > 0;
  db.transaction(() => {
    if (adopted) store.updateNow('devicePreferences', { ...store.getWithMetaNow('devicePreferences').value, ...adoption.patch });
    db.insert(appSettings).values({ key: MOVED_KEY, value: new Date().toISOString() }).run();
  });
  if (adopted) devicePreferencesChanged(store);
  return { devicePreferences: store.getWithMetaNow('devicePreferences').value, settled: adoption.settled };
}
