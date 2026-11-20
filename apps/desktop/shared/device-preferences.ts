/**
 * @@@device-preferences — this device's own preferences: theme, language, sidebar tint, tray badge, chat notifications,
 * meeting reminder. One store per shell, chosen once (src/lib/devicePreferences.ts), ❌ "read one, else the other":
 * - desktop: main's app setting `devicePreferences`. Main applies theme, language and tray badge from it itself; the
 *   renderer gets it before its first frame in the first-frame answer (shared/first-frame.ts).
 * - web / phone: localStorage, under the keys below, one key per preference as the desktop also kept them before.
 * The desktop's old keys are moved into main once: preload sends what they hold with its first-frame request, main
 * adopts what it has no value of its own for, and preload deletes the keys main settled.
 * Dependency-free: preload, main and the renderer import it.
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type LocalePreference = 'system' | 'zh-CN' | 'en-US'

export type DevicePreferences = {
  theme: ThemePreference
  locale: LocalePreference
  sidebarTint: boolean
  trayBadge: boolean
  /** Chat messages raise a notification (direct messages, a group message that names you). */
  chatMessages: boolean
  /** The chat notification makes a sound. */
  chatSound: boolean
  meetingReminder: boolean
  confirmBeforeCancelAndSend: boolean
}

/** @@@1424 the factory theme is light; language follows the system; the tint is off; badge, notifications and reminder on. */
export const DEVICE_PREFERENCES_FACTORY: DevicePreferences = {
  theme: 'light',
  locale: 'system',
  sidebarTint: false,
  trayBadge: true,
  chatMessages: true,
  chatSound: true,
  meetingReminder: true,
  confirmBeforeCancelAndSend: true,
}

type StoredRule = {
  key: string
  /** What one stored string says; undefined = unreadable. */
  read: (raw: string) => Partial<DevicePreferences> | undefined
  write: (preferences: DevicePreferences) => string
}

function readJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The localStorage form of each preference (web / phone, and the desktop before the move). */
export const STORED_PREFERENCES = {
  theme: {
    key: 'app-theme',
    // The retired `plain-white` reads as light.
    read: (raw) => (raw === 'plain-white' ? { theme: 'light' } : raw === 'light' || raw === 'dark' || raw === 'system' ? { theme: raw } : undefined),
    write: (p) => p.theme,
  },
  locale: {
    key: 'gugu.locale.preference.v1',
    read: (raw) => (raw === 'system' || raw === 'zh-CN' || raw === 'en-US' ? { locale: raw } : undefined),
    write: (p) => p.locale,
  },
  sidebarTint: {
    key: 'gugu.sidebar-tint',
    // Only the literal 'true' is on.
    read: (raw) => ({ sidebarTint: raw === 'true' }),
    write: (p) => String(p.sidebarTint),
  },
  trayBadge: {
    key: 'gugu.tray-badge-enabled',
    read: (raw) => ({ trayBadge: raw !== 'false' }),
    write: (p) => String(p.trayBadge),
  },
  chatNotifications: {
    key: 'gugu.notification-settings',
    // `{ chatMessages, sound }`; the older `{ messages, requests }` carries `messages` (#5301: `requests` was never read).
    read: (raw) => {
      const value = readJsonObject(raw)
      if (!value) return undefined
      const chatMessages = typeof value.chatMessages === 'boolean' ? value.chatMessages : typeof value.messages === 'boolean' ? value.messages : true
      return { chatMessages, chatSound: typeof value.sound === 'boolean' ? value.sound : true }
    },
    write: (p) => JSON.stringify({ chatMessages: p.chatMessages, sound: p.chatSound }),
  },
  meetingReminder: {
    key: 'gugu.voiceNotes.meetingReminder',
    read: (raw) => ({ meetingReminder: raw !== 'off' }),
    write: (p) => (p.meetingReminder ? 'on' : 'off'),
  },
  confirmBeforeCancelAndSend: {
    key: 'gugu.confirm-before-cancel-and-send',
    read: (raw) => ({ confirmBeforeCancelAndSend: raw !== 'false' }),
    write: (p) => String(p.confirmBeforeCancelAndSend),
  },
} satisfies Record<string, StoredRule>

export type StoredPreferenceName = keyof typeof STORED_PREFERENCES
const STORED_NAMES = Object.keys(STORED_PREFERENCES) as StoredPreferenceName[]

/** What the keys hold, as stored strings (only the keys that hold something). */
export type StoredPreferenceStrings = Partial<Record<StoredPreferenceName, string>>

export function storedPreferenceStrings(storage: Pick<Storage, 'getItem'>): StoredPreferenceStrings {
  const strings: StoredPreferenceStrings = {}
  for (const name of STORED_NAMES) {
    const raw = storage.getItem(STORED_PREFERENCES[name].key)
    if (raw !== null) strings[name] = raw
  }
  return strings
}

/** The web / phone store's value: each key read by its rule; a key never written, or unreadable, is the factory value. */
export function readStoredPreferences(storage: Pick<Storage, 'getItem'>): DevicePreferences {
  const strings = storedPreferenceStrings(storage)
  const preferences = { ...DEVICE_PREFERENCES_FACTORY }
  for (const name of STORED_NAMES) {
    const raw = strings[name]
    if (raw !== undefined) Object.assign(preferences, STORED_PREFERENCES[name].read(raw))
  }
  return preferences
}

/** Each key whose preference changed (a key never written stays unwritten while its value is the factory one). */
export function writeStoredPreferences(storage: Pick<Storage, 'setItem'>, next: DevicePreferences, previous: DevicePreferences): void {
  for (const name of STORED_NAMES) {
    const rule = STORED_PREFERENCES[name]
    if (rule.write(next) !== rule.write(previous)) storage.setItem(rule.key, rule.write(next))
  }
}

export function removeStoredPreferences(storage: Pick<Storage, 'removeItem'>, names: readonly StoredPreferenceName[]): void {
  for (const name of names) storage.removeItem(STORED_PREFERENCES[name].key)
}

export type Adoption = {
  /** The fields to write into main's setting. */
  patch: Partial<DevicePreferences>
  /** The keys preload may delete: adopted, main's own value won, or unreadable (said by main). */
  settled: StoredPreferenceName[]
  unreadable: StoredPreferenceName[]
}

/** Main's side of the move: per old key, main's own stored value wins, else what the key says is adopted. */
export function adoptStoredPreferences(strings: StoredPreferenceStrings, mainHas: (field: keyof DevicePreferences) => boolean): Adoption {
  const adoption: Adoption = { patch: {}, settled: [], unreadable: [] }
  for (const name of STORED_NAMES) {
    const raw = strings[name]
    if (raw === undefined) continue
    const value = STORED_PREFERENCES[name].read(raw)
    if (value === undefined) adoption.unreadable.push(name)
    else for (const [field, fieldValue] of Object.entries(value)) {
      if (!mainHas(field as keyof DevicePreferences)) Object.assign(adoption.patch, { [field]: fieldValue })
    }
    adoption.settled.push(name)
  }
  return adoption
}

type FirstFrameHost = { guguFirstFrame?: { devicePreferences: DevicePreferences | null }; localStorage?: Storage }

/** This document's localStorage; none (a node test, an opaque origin) = null. */
export function documentStorage(host: FirstFrameHost): Storage | null {
  try {
    return host.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * The shell's preferences at its first moment, dependency-free (the language runtime reads them before anything else
 * loads): desktop = main's first-frame answer (the factory values when main had none to give; said by main), web / phone
 * = localStorage.
 */
export function firstDevicePreferences(host: FirstFrameHost): DevicePreferences {
  if (host.guguFirstFrame) return host.guguFirstFrame.devicePreferences ?? DEVICE_PREFERENCES_FACTORY
  const storage = documentStorage(host)
  return storage ? readStoredPreferences(storage) : DEVICE_PREFERENCES_FACTORY
}
