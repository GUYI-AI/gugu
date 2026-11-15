import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import { sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { log } from '@main/lib/logger';
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings';
import { BUILTIN_THEME_PACKS, isThemePack, slotsStylesheet, validThemePackSlots, type ThemePack } from '@shared/theme/theme-packs';
import {
  HANDED_OVER_SETTINGS,
  parseChatNotifications,
  parseImportedThemePacks,
  parseLocalePreference,
  parseMeetingReminder,
  parseSidebarTint,
  parseThemePackSlots,
  parseThemePreference,
  parseTrayBadge,
  type DeviceSettingsAnswer,
  type DeviceSettingsHandover,
  type LegacyDevicePreferences,
  type LegacyPreferenceName,
} from '../../../../../shared/device-preferences';
import { getDefaultForKey } from './settings-registry';
import { appSettingsService, type SettingsMeta, type SettingsStore } from './settings-service';
import { isPlainObject } from './utils';

/**
 * @@@device-preferences — main's side (shared/device-preferences.ts): the synchronous handover preload asks for before the
 * first frame (with the one-time migration of the old localStorage keys), the imported theme packs (a file under
 * userData: several KB each, over what a settings row is for) and the stylesheet derived from slots + packs.
 */

// ── imported theme packs ─────────────────────────────────────────────────────────────────────────────────────────

const importedPacksFile = (): string => join(app.getPath('userData'), 'theme-packs', 'imported.json');

/** The imported packs; none stored yet = none. A file that is there but unreadable is said, ❌ read as none. */
export function readImportedThemePacks(): ThemePack[] {
  const file = importedPacksFile();
  if (!existsSync(file)) return [];
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} does not hold a list of theme packs`);
  return parsed.filter(isThemePack);
}

export function writeImportedThemePacks(packs: readonly ThemePack[]): void {
  const file = importedPacksFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(packs));
  renameSync(tmp, file);
}

/** Every pack there is: builtin first, then imported. */
export function allThemePacks(): ThemePack[] {
  return [...BUILTIN_THEME_PACKS, ...readImportedThemePacks()];
}

/** The stylesheet the stored slots stand for ('' = Gugu's own colours). Derived, ❌ stored. */
export function themePackStylesheetNow(store: SettingsStore = appSettingsService): string {
  const packs = allThemePacks();
  return slotsStylesheet(validThemePackSlots(store.getWithMetaNow('themePackSlots').value, packs), packs);
}

// ── who follows a change ─────────────────────────────────────────────────────────────────────────────────────────

const changeListeners = new Set<(key: AppSettingsKey) => void>();

/** Main-side followers of a settings change (the host's tray badge): the controller calls `settingsChanged` per write. */
export function onAppSettingsChanged(listener: (key: AppSettingsKey) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function settingsChanged(key: AppSettingsKey): void {
  for (const listener of changeListeners) {
    try {
      listener(key);
    } catch (error) {
      log.error('a settings change follower failed', { key, error: String(error) });
    }
  }
}

/** @@@5295 the tray badge setting, for the host (it has no renderer storage to read). */
export async function trayBadgeEnabled(): Promise<boolean> {
  return (await appSettingsService.get('interface')).trayBadge;
}

// ── handover + one-time migration ────────────────────────────────────────────────────────────────────────────────

function hasSettingsTable(): boolean {
  return db.all(sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'`).length > 0;
}

/** Whether main has its own value for a setting (a row), or for one field of an object setting (a field of that row). */
function stored(store: SettingsStore, key: AppSettingsKey, field?: string): boolean {
  const raw = store.readRaw(key);
  if (raw === null || raw === undefined) return false;
  return field === undefined || (isPlainObject(raw) && field in raw);
}

type Adoption = {
  key: AppSettingsKey;
  field?: string;
  /** The value to adopt as the whole setting, or undefined when the old value says nothing usable. */
  value: (legacy: LegacyDevicePreferences, store: SettingsStore) => unknown;
};

function withField<K extends 'interface' | 'assistant'>(store: SettingsStore, key: K, field: keyof AppSettings[K], value: unknown): AppSettings[K] | undefined {
  return value === undefined ? undefined : { ...store.getWithMetaNow(key).value, [field]: value };
}

const ADOPTIONS: Record<Exclude<LegacyPreferenceName, 'importedThemePacks'>, Adoption> = {
  theme: { key: 'theme', value: (legacy) => parseThemePreference(legacy.theme) },
  locale: { key: 'locale', value: (legacy) => parseLocalePreference(legacy.locale) },
  themePackSlots: { key: 'themePackSlots', value: (legacy) => parseThemePackSlots(legacy.themePackSlots) },
  chatNotifications: { key: 'chatNotifications', value: (legacy) => parseChatNotifications(legacy.chatNotifications) },
  sidebarTint: { key: 'interface', field: 'sidebarTint', value: (legacy, store) => withField(store, 'interface', 'sidebarTint', parseSidebarTint(legacy.sidebarTint)) },
  trayBadge: { key: 'interface', field: 'trayBadge', value: (legacy, store) => withField(store, 'interface', 'trayBadge', parseTrayBadge(legacy.trayBadge)) },
  meetingReminder: { key: 'assistant', field: 'meetingReminder', value: (legacy, store) => withField(store, 'assistant', 'meetingReminder', parseMeetingReminder(legacy.meetingReminder)) },
  hiddenIdeasEntries: { key: 'assistant', field: 'hiddenIdeasEntries', value: (legacy, store) => withField(store, 'assistant', 'hiddenIdeasEntries', legacy.hiddenIdeasEntries) },
};

/**
 * Settle each old key preload found: main already has its own value → main wins; main has none → the old value is
 * written (a value that says nothing usable is simply dropped). Returns the old keys settled: preload deletes exactly
 * those. One that could not be written stays where it is for the next start.
 */
export function adoptLegacyPreferences(legacy: LegacyDevicePreferences, store: SettingsStore = appSettingsService): LegacyPreferenceName[] {
  const settled: LegacyPreferenceName[] = [];
  for (const name of Object.keys(legacy) as LegacyPreferenceName[]) {
    try {
      if (name === 'importedThemePacks') {
        const packs = parseImportedThemePacks(legacy.importedThemePacks, isThemePack);
        if (!existsSync(importedPacksFile()) && packs?.length) writeImportedThemePacks(packs);
      } else {
        const adoption = ADOPTIONS[name];
        if (!adoption) continue;
        const value = stored(store, adoption.key, adoption.field) ? undefined : adoption.value(legacy, store);
        if (value !== undefined) store.updateNow(adoption.key, value as never);
      }
      settled.push(name);
    } catch (error) {
      log.error('an old device preference could not be moved into the settings; it is kept for the next start', { name, error: String(error) });
    }
  }
  return settled;
}

function handover(store: SettingsStore, hasTable: boolean): DeviceSettingsHandover {
  const meta = (key: AppSettingsKey): SettingsMeta<AppSettingsKey> => {
    if (hasTable) return store.getWithMetaNow(key);
    const defaults = getDefaultForKey(key);
    return { value: defaults, defaults, overrides: {} };
  };
  return {
    settings: Object.fromEntries(HANDED_OVER_SETTINGS.map((key) => [key, meta(key)])) as DeviceSettingsHandover['settings'],
    themePackCss: hasTable ? themePackStylesheetNow(store) : '',
  };
}

/**
 * Preload's synchronous request: adopt what the old keys hold, then hand over the settings the first frame draws. A
 * database without the settings table yet (a first start, before its migrations) has nothing stored and adopts nothing
 * (the old keys stay for the next start).
 */
export function answerDeviceSettings(legacy: LegacyDevicePreferences, store: SettingsStore = appSettingsService): DeviceSettingsAnswer {
  const hasTable = hasSettingsTable();
  const settled = hasTable ? adoptLegacyPreferences(legacy, store) : [];
  for (const name of settled) {
    const adoption = name === 'importedThemePacks' ? null : ADOPTIONS[name];
    if (adoption) settingsChanged(adoption.key);
  }
  return { handover: handover(store, hasTable), settled };
}
