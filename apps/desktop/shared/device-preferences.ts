/**
 * @@@device-preferences — this device's preferences have one store per shell. Desktop: main's app settings, handed over by
 * preload synchronously before the first frame (DEVICE_SETTINGS_CHANNEL); boot script, language runtime and settings
 * replica all start from that answer. The theme-pack stylesheet is derived by main from slots + packs, ❌ stored.
 * Web / phone: localStorage under the keys below (❌ a fallback). On desktop preload reads those keys once (the migration)
 * and deletes each one main settled (adopted, or main's own value wins). Dependency-free: preload, main, renderer import it.
 */
import type { ThemePack } from '../src/session/shared/theme/theme-packs'

export const DEVICE_SETTINGS_CHANNEL = 'device-settings:handover'
/** What preload exposes on `window` (desktop only): its presence is what makes a shell the desktop shell. */
export const DEVICE_SETTINGS_GLOBAL = 'guguDeviceSettings'

export type ThemePreference = 'light' | 'dark' | 'system'
export type LocalePreference = 'system' | 'zh-CN' | 'en-US'
export type ThemePackSlots = { light?: string; dark?: string }
export type ChatNotifications = { chatMessages: boolean; sound: boolean }

/** The localStorage keys, as the web and phone shells store them (and the desktop did before the migration). */
export const PREFERENCE_STORAGE_KEYS = {
  theme: 'app-theme',
  locale: 'gugu.locale.preference.v1',
  sidebarTint: 'gugu.sidebar-tint',
  trayBadge: 'gugu.tray-badge-enabled',
  chatNotifications: 'gugu.notification-settings',
  meetingReminder: 'gugu.voiceNotes.meetingReminder',
  themePackSlots: 'app-theme-pack',
  importedThemePacks: 'app-theme-packs-imported',
  /** The derived stylesheet the inline boot script inserts (web / phone); desktop gets it from main. */
  themePackCss: 'app-theme-pack-css',
} as const

/** One key per assistant whose ideas entry is hidden (value `hidden`). */
export const IDEAS_ENTRY_KEY_PREFIX = 'gugu.assistant.ideasEntry:'

export function ideasEntryKeys(storage: Pick<Storage, 'key' | 'length'>): string[] {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key?.startsWith(IDEAS_ENTRY_KEY_PREFIX)) keys.push(key)
  }
  return keys
}

/** What preload read of the old keys: raw strings, parsed by main (the same parsers the web shell reads them with). */
export type LegacyDevicePreferences = {
  [K in Exclude<keyof typeof PREFERENCE_STORAGE_KEYS, 'themePackCss'>]?: string
} & { hiddenIdeasEntries?: string[] }

export type LegacyPreferenceName = keyof LegacyDevicePreferences

/** The app settings keys preload hands over (their values are the settings replica's first value). */
export const HANDED_OVER_SETTINGS = ['theme', 'locale', 'interface', 'themePackSlots', 'chatNotifications', 'assistant'] as const
export type HandedOverSetting = (typeof HANDED_OVER_SETTINGS)[number]

export type DeviceSettingsHandover = {
  /** `{ value, defaults, overrides }` per key, the shape `appSettings.getWithMeta` answers. */
  settings: Record<HandedOverSetting, { value: unknown; defaults: unknown; overrides: unknown }>
  /** The theme-pack stylesheet derived from the stored slots; '' = Gugu's own colours. */
  themePackCss: string
}

export type DeviceSettingsAnswer = {
  handover: DeviceSettingsHandover
  /** The old keys main has settled: preload deletes exactly these. */
  settled: LegacyPreferenceName[]
}

/** What preload exposes: null when main could not answer (logged there); the renderer then reads its settings as usual. */
export type DeviceSettingsGlobal = { handover: DeviceSettingsHandover | null }

// ── parsers: one rule per key, for main (migration) and the web / phone store ──────────────────────────────────────

/** @@@1424 the factory theme is light; the retired `plain-white` reads as light. */
export function parseThemePreference(raw: string | null | undefined): ThemePreference | undefined {
  if (raw === 'plain-white') return 'light'
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : undefined
}

export function parseLocalePreference(raw: string | null | undefined): LocalePreference | undefined {
  return raw === 'system' || raw === 'zh-CN' || raw === 'en-US' ? raw : undefined
}

/** Only the literal 'true' is on (the inline boot script's rule). */
export const parseSidebarTint = (raw: string | null | undefined): boolean | undefined => (raw == null ? undefined : raw === 'true')
export const parseTrayBadge = (raw: string | null | undefined): boolean | undefined => (raw == null ? undefined : raw !== 'false')
export const parseMeetingReminder = (raw: string | null | undefined): boolean | undefined => (raw == null ? undefined : raw !== 'off')

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** `{ chatMessages, sound }`; the older `{ messages, requests }` carries `messages` over (#5301: `requests` was never read). */
export function parseChatNotifications(raw: string | null | undefined): ChatNotifications | undefined {
  const parsed = parseJson(raw)
  if (!parsed || typeof parsed !== 'object') return undefined
  const value = parsed as Record<string, unknown>
  const chatMessages = typeof value.chatMessages === 'boolean' ? value.chatMessages : typeof value.messages === 'boolean' ? value.messages : true
  return { chatMessages, sound: typeof value.sound === 'boolean' ? value.sound : true }
}

export function parseThemePackSlots(raw: string | null | undefined): ThemePackSlots | undefined {
  const parsed = parseJson(raw)
  if (!parsed || typeof parsed !== 'object') return undefined
  const value = parsed as Record<string, unknown>
  const slots: ThemePackSlots = {}
  for (const mode of ['light', 'dark'] as const) if (typeof value[mode] === 'string') slots[mode] = value[mode] as string
  return slots
}

export function parseImportedThemePacks(raw: string | null | undefined, isPack: (value: unknown) => value is ThemePack): ThemePack[] | undefined {
  const parsed = parseJson(raw)
  return Array.isArray(parsed) ? parsed.filter(isPack) : undefined
}

// ── preload: the one-time migration and the handover ────────────────────────────────────────────────────────────

type LegacyStorage = Pick<Storage, 'getItem' | 'removeItem' | 'key' | 'length'>

/** What the old keys hold (only those that hold something). */
export function readLegacyPreferences(storage: LegacyStorage): LegacyDevicePreferences {
  const legacy: LegacyDevicePreferences = {}
  for (const [name, key] of Object.entries(PREFERENCE_STORAGE_KEYS) as [keyof typeof PREFERENCE_STORAGE_KEYS, string][]) {
    if (name === 'themePackCss') continue
    const raw = storage.getItem(key)
    if (raw !== null) legacy[name] = raw
  }
  const hidden = ideasEntryKeys(storage).filter((key) => storage.getItem(key) === 'hidden').map((key) => key.slice(IDEAS_ENTRY_KEY_PREFIX.length))
  if (hidden.length) legacy.hiddenIdeasEntries = hidden
  return legacy
}

function removeLegacy(storage: LegacyStorage, name: LegacyPreferenceName): void {
  if (name !== 'hiddenIdeasEntries') storage.removeItem(PREFERENCE_STORAGE_KEYS[name])
  else for (const key of ideasEntryKeys(storage)) storage.removeItem(key)
}

/** Preload: send the old keys with the handover request (`ask`, sync IPC), delete the ones main settled; the stylesheet key always goes. */
export function takeDeviceSettings(storage: LegacyStorage, ask: (legacy: LegacyDevicePreferences) => DeviceSettingsAnswer | null): DeviceSettingsGlobal {
  const answer = ask(readLegacyPreferences(storage))
  if (!answer) return { handover: null }
  for (const name of answer.settled) removeLegacy(storage, name)
  storage.removeItem(PREFERENCE_STORAGE_KEYS.themePackCss)
  return { handover: answer.handover }
}

/** The language preference for a script that runs before the renderer's modules (the boot poster's slogan), from the same store. */
export function bootLocalePreference(host: { guguDeviceSettings?: DeviceSettingsGlobal; localStorage?: Pick<Storage, 'getItem'> }): LocalePreference {
  if (host.guguDeviceSettings) {
    // @@@reading-default - the poster's slogan when main gave no handover: the system language (i18n says so too).
    // Not reached on a normal start: preload's handover answers before the first frame (measured on Electron, PR 3 D1–D3).
    return parseLocalePreference(host.guguDeviceSettings.handover?.settings.locale.value as string | undefined) ?? 'system'
  }
  let stored: string | null | undefined
  try {
    stored = host.localStorage?.getItem(PREFERENCE_STORAGE_KEYS.locale)
  } catch {
    // No storage for this document (an opaque origin): nothing was ever stored here.
    stored = null
  }
  return parseLocalePreference(stored) ?? 'system'
}
