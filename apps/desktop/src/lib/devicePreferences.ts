import { queryClient, useReplica, type Reading } from './replica'
import { createSelectStore, useSelect } from './selectStore'
import { rendererLogger } from './log'
import {
  appSettingsModel,
  LOCAL_SETTINGS_HOST_KEY,
  watchAppSettingsChanges,
  writeLocalAppSetting,
  type SettingsMeta,
} from '@renderer/features/settings/app-settings-client'
import type { AppSettings, AppSettingsKey } from '@shared/core/app-settings'
import {
  HANDED_OVER_SETTINGS,
  IDEAS_ENTRY_KEY_PREFIX,
  PREFERENCE_STORAGE_KEYS,
  parseChatNotifications,
  parseLocalePreference,
  parseMeetingReminder,
  parseSidebarTint,
  parseThemePackSlots,
  parseThemePreference,
  parseTrayBadge,
  type ChatNotifications,
  type LocalePreference,
  type ThemePackSlots,
  type ThemePreference,
} from '../../shared/device-preferences'

/**
 * @@@device-preferences — this device's preferences behind one interface, with one store per shell, chosen once here:
 * - desktop (preload handed over `window.guguDeviceSettings`): main's app settings, read through the renderer's
 *   `appSettings` replica. Their first value is preload's handover (the replica's `local`), the same answer the inline
 *   boot script painted with; a change from any window arrives as `appSettingsChangedChannel` and is read again.
 * - web / phone: localStorage, their only device store (shared/device-preferences.ts has the keys and their rules).
 * ❌ "read one, else the other": the desktop never touches the old localStorage keys (preload migrated them once), the
 * web and phone never touch app settings.
 */
export type DevicePreferenceValues = {
  theme: ThemePreference
  locale: LocalePreference
  sidebarTint: boolean
  trayBadge: boolean
  chatNotifications: ChatNotifications
  meetingReminder: boolean
  hiddenIdeasEntries: readonly string[]
  themePackSlots: ThemePackSlots
}
export type DevicePreferenceName = keyof DevicePreferenceValues

export type DevicePreferences = {
  /** Which store this shell has (decided once, at module load). */
  readonly backend: 'appSettings' | 'localStorage'
  /** The preference now, for logic outside React (a one-moment decision). */
  read<N extends DevicePreferenceName>(name: N): Reading<DevicePreferenceValues[N]>
  /** Any preference changed (this window, another window, main). */
  subscribe(listener: () => void): () => void
  /** Store a new value; shown at once. */
  write<N extends DevicePreferenceName>(name: N, value: DevicePreferenceValues[N]): void
  /** The preference as a surface draws it. */
  use<N extends DevicePreferenceName>(name: N): Reading<DevicePreferenceValues[N]>
}

const log = rendererLogger('device-preferences')

const valueReading = <V>(value: V): Reading<V> => ({ state: 'value', value, stale: false, error: null })

// ── desktop: app settings ────────────────────────────────────────────────────────────────────────────────────────

type Source<N extends DevicePreferenceName> = {
  key: AppSettingsKey
  get: (value: never) => DevicePreferenceValues[N]
  put: (current: never, value: DevicePreferenceValues[N]) => unknown
}
const whole = <N extends DevicePreferenceName>(key: AppSettingsKey): Source<N> => ({ key, get: (value) => value, put: (_current, value) => value })
const field = <N extends DevicePreferenceName>(key: 'interface' | 'assistant', name: string): Source<N> => ({
  key,
  get: (value: Record<string, unknown>) => value[name] as DevicePreferenceValues[N],
  put: (current: Record<string, unknown>, value) => ({ ...current, [name]: value }),
} as Source<N>)

/** Where each preference lives in app settings. */
const SOURCES: { [N in DevicePreferenceName]: Source<N> } = {
  theme: whole('theme'),
  locale: whole('locale'),
  themePackSlots: whole('themePackSlots'),
  chatNotifications: whole('chatNotifications'),
  sidebarTint: field('interface', 'sidebarTint'),
  trayBadge: field('interface', 'trayBadge'),
  meetingReminder: field('assistant', 'meetingReminder'),
  hiddenIdeasEntries: field('assistant', 'hiddenIdeasEntries'),
}

function mapReading<N extends DevicePreferenceName>(name: N, reading: Reading<unknown>): Reading<DevicePreferenceValues[N]> {
  if (reading.state !== 'value') return reading
  return { ...reading, value: SOURCES[name].get((reading.value as SettingsMeta<AppSettingsKey>).value as never) }
}

export function appSettingsPreferences(): DevicePreferences {
  watchAppSettingsChanges()
  // The handed-over keys are values from the first moment: asking seeds them from preload's answer (`local`, synchronous)
  // and reads them again from main in the background.
  for (const key of HANDED_OVER_SETTINGS) void appSettingsModel.prefetch(key, LOCAL_SETTINGS_HOST_KEY)
  const keys = new Set(Object.values(SOURCES).map((source) => source.key))
  return {
    backend: 'appSettings',
    read: (name) => mapReading(name, appSettingsModel.peek(SOURCES[name].key, LOCAL_SETTINGS_HOST_KEY)),
    subscribe: (listener) => queryClient.getQueryCache().subscribe((event) => {
      const [model, , key, host] = event.query.queryKey
      if (model === appSettingsModel.name && host === LOCAL_SETTINGS_HOST_KEY && keys.has(key as AppSettingsKey) && (event.type === 'updated' || event.type === 'added' || event.type === 'removed')) listener()
    }),
    write: (name, value) => {
      const { key, put } = SOURCES[name]
      const reading = appSettingsModel.peek(key, LOCAL_SETTINGS_HOST_KEY)
      if (reading.state !== 'value') throw new Error(`device preference ${name}: its setting was never read`)
      const next = put((reading.value as SettingsMeta<AppSettingsKey>).value as never, value) as AppSettings[AppSettingsKey]
      void writeLocalAppSetting(key, next).catch(() => { /* put back and said by writeLocalAppSetting */ })
    },
    // eslint-disable-next-line react-hooks/rules-of-hooks -- `use` is a hook: called only from `useDevicePreference`.
    use: (name) => mapReading(name, useReplica(appSettingsModel, [SOURCES[name].key, LOCAL_SETTINGS_HOST_KEY])),
  }
}

// ── web / phone: localStorage ────────────────────────────────────────────────────────────────────────────────────

type StoredRule<N extends DevicePreferenceName> = {
  /** What is stored, as one string: a reading is parsed again only when this moved (a test or another tab may write). */
  raw: (storage: Storage) => string | null
  read: (storage: Storage) => DevicePreferenceValues[N]
  write: (storage: Storage, value: DevicePreferenceValues[N]) => void
}
const single = <N extends DevicePreferenceName>(key: string, parse: (raw: string | null) => DevicePreferenceValues[N] | undefined, factory: DevicePreferenceValues[N], serialize: (value: DevicePreferenceValues[N]) => string): StoredRule<N> => ({
  raw: (storage) => storage.getItem(key),
  read: (storage) => parse(storage.getItem(key)) ?? factory,
  write: (storage, value) => storage.setItem(key, serialize(value)),
})

function ideasKeys(storage: Storage): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith(IDEAS_ENTRY_KEY_PREFIX)) keys.push(key)
  }
  return keys
}

const K = PREFERENCE_STORAGE_KEYS
/** Each preference's localStorage form; a key never written (or not understood) is the factory value. */
const STORED: { [N in DevicePreferenceName]: StoredRule<N> } = {
  theme: single(K.theme, parseThemePreference, 'light', String),
  locale: single(K.locale, parseLocalePreference, 'system', String),
  sidebarTint: single(K.sidebarTint, parseSidebarTint, false, String),
  trayBadge: single(K.trayBadge, parseTrayBadge, true, String),
  meetingReminder: single(K.meetingReminder, parseMeetingReminder, true, (on) => (on ? 'on' : 'off')),
  chatNotifications: single(K.chatNotifications, parseChatNotifications, { chatMessages: true, sound: true }, JSON.stringify),
  themePackSlots: single(K.themePackSlots, parseThemePackSlots, {}, JSON.stringify),
  hiddenIdeasEntries: {
    raw: (storage) => ideasKeys(storage).filter((key) => storage.getItem(key) === 'hidden').join('\n'),
    read: (storage) => ideasKeys(storage).filter((key) => storage.getItem(key) === 'hidden').map((key) => key.slice(IDEAS_ENTRY_KEY_PREFIX.length)),
    write: (storage, ids) => {
      for (const key of ideasKeys(storage)) if (!ids.includes(key.slice(IDEAS_ENTRY_KEY_PREFIX.length))) storage.removeItem(key)
      for (const id of ids) storage.setItem(IDEAS_ENTRY_KEY_PREFIX + id, 'hidden')
    },
  },
}

/** Which preference a localStorage key holds (another tab of the web page wrote it). */
function nameOfStorageKey(key: string | null): DevicePreferenceName | null | 'all' {
  // null: the whole storage was cleared.
  if (key === null) return 'all'
  if (key.startsWith(IDEAS_ENTRY_KEY_PREFIX)) return 'hiddenIdeasEntries'
  const found = (Object.keys(STORED) as DevicePreferenceName[]).find((name) => (K as Record<string, string>)[name] === key)
  return found ?? null
}

export function localStoragePreferences(storage: Storage | null): DevicePreferences {
  // No localStorage (a node test importing this): kept in memory for this run.
  const store = storage ?? memoryStorage()
  // One reading per preference, kept while what is stored stays the same: readers compare by identity.
  const readings = new Map<DevicePreferenceName, { raw: string | null; reading: Reading<unknown> }>()
  const changes = createSelectStore(0)
  const changed = () => { changes.publish(changes.get() + 1); changes.notify() }
  const read = <N extends DevicePreferenceName>(name: N): Reading<DevicePreferenceValues[N]> => {
    const from = store
    const raw = STORED[name].raw(from)
    let kept = readings.get(name)
    if (!kept || kept.raw !== raw) {
      kept = { raw, reading: valueReading(STORED[name].read(from)) }
      readings.set(name, kept)
    }
    return kept.reading as Reading<DevicePreferenceValues[N]>
  }
  // Another tab of the web page wrote one: readers read again.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => { if (nameOfStorageKey(event.key)) changed() })
  }
  return {
    backend: 'localStorage',
    read,
    subscribe: changes.subscribe,
    write: (name, value) => {
      try {
        STORED[name].write(store, value)
        readings.set(name, { raw: STORED[name].raw(store), reading: valueReading(value) })
      } catch (error) {
        // Not stored (private mode, quota): not kept on this device; it is said, and the shown value stays what is stored.
        log.error({ name, error: String(error) }, `${name}: not stored on this device`)
      }
      changed()
    },
    // eslint-disable-next-line react-hooks/rules-of-hooks -- `use` is a hook: called only from `useDevicePreference`.
    use: (name) => useSelect(changes, () => read(name)),
  }
}

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() { return items.size },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, String(value)) },
    removeItem: (key: string) => { items.delete(key) },
    clear: () => items.clear(),
  }
}

// ── this shell's store ───────────────────────────────────────────────────────────────────────────────────────────

/** This document's localStorage; none (a node test, an opaque origin) = kept in memory for this run. */
export function documentStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export const devicePreferences: DevicePreferences = typeof window !== 'undefined' && window.guguDeviceSettings
  ? appSettingsPreferences()
  : localStoragePreferences(documentStorage())

export function useDevicePreference<N extends DevicePreferenceName>(name: N): Reading<DevicePreferenceValues[N]> {
  return devicePreferences.use(name)
}
