import { useSyncExternalStore } from 'react'
import { rendererLogger } from './log'
import {
  appSettingsModel,
  LOCAL_SETTINGS_HOST_KEY,
  updateAppSettingsRequest,
  type SettingsMeta,
} from '@renderer/features/settings/app-settings-client'
import { applyLocalePreference, getLocaleSnapshot } from '@/i18n/runtime'
import type { LocalePreference } from '@/i18n/locale'
import {
  DEVICE_PREFERENCES_FACTORY,
  documentStorage,
  readStoredPreferences,
  storedPreferenceStrings,
  writeStoredPreferences,
  type DevicePreferences,
} from '../../shared/device-preferences'
import { FIRST_FRAME_GLOBAL, type FirstFrameGlobal } from '../../shared/first-frame'

/**
 * @@@device-preferences — this device's preferences for the renderer (shared/device-preferences.ts), the shell's store
 * chosen once here, ❌ "read one, else the other":
 * - desktop (preload handed over the first frame): main's app setting, read through the appSettings replica, whose first
 *   value is main's first-frame answer;
 * - web / phone: localStorage.
 * Not imported by the language runtime (an import cycle back through ipc): it reads its first value dependency-free.
 */
type Store = {
  read(): DevicePreferences
  write(next: DevicePreferences): void
  subscribe(listener: () => void): () => void
}

const log = rendererLogger('device-preferences')
const KEY = 'devicePreferences' as const

function appSettingsStore(firstFrame: FirstFrameGlobal): Store {
  const args = [KEY, LOCAL_SETTINGS_HOST_KEY] as [typeof KEY, string]
  if (firstFrame.devicePreferences) {
    appSettingsModel.set(args, { value: firstFrame.devicePreferences, defaults: DEVICE_PREFERENCES_FACTORY, overrides: {} })
  } else {
    // Main said why; the boot script drew the factory values, and they show until this read lands.
    log.error({}, 'main handed over no device preferences; reading them now')
    void appSettingsModel.prefetch(...args)
  }
  return {
    read: () => {
      const reading = appSettingsModel.peek(...args)
      return reading.state === 'value' ? (reading.value as SettingsMeta<typeof KEY>).value : DEVICE_PREFERENCES_FACTORY
    },
    write: (next) => {
      appSettingsModel.set(args, (old) => ({ defaults: DEVICE_PREFERENCES_FACTORY, overrides: {}, ...old, value: next }))
      // Shown at once; a refused write is said and the stored value read back.
      updateAppSettingsRequest(KEY, next).catch((error: unknown) => {
        log.error({ error: String(error) }, 'device preferences not stored; reading back what is')
        void appSettingsModel.refresh(...args)
      })
    },
    subscribe: (listener) => appSettingsModel.subscribe(args, listener),
  }
}

function localStorageStore(storage: Storage | null): Store {
  const listeners = new Set<() => void>()
  let raw: string | null = null
  let current = DEVICE_PREFERENCES_FACTORY
  const emit = () => { for (const listener of listeners) listener() }
  // Another tab (web) wrote a key.
  if (typeof window !== 'undefined') window.addEventListener('storage', emit)
  return {
    // Parsed again only when what is stored moved: readers compare by identity.
    read: () => {
      if (!storage) return current
      const now = JSON.stringify(storedPreferenceStrings(storage))
      if (now !== raw) { raw = now; current = readStoredPreferences(storage) }
      return current
    },
    write: (next) => {
      if (!storage) current = next
      else {
        try {
          writeStoredPreferences(storage, next, current)
        } catch (error) {
          // Not stored (private mode, quota): said; what shows stays what is stored.
          log.error({ error: String(error) }, 'device preferences not stored on this device')
        }
      }
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const firstFrame = typeof window === 'undefined' ? undefined : (window as unknown as Record<string, FirstFrameGlobal | undefined>)[FIRST_FRAME_GLOBAL]
const store: Store = firstFrame
  ? appSettingsStore(firstFrame)
  : localStorageStore(typeof window === 'undefined' ? null : documentStorage(window))

export const readDevicePreferences = (): DevicePreferences => store.read()
export const subscribeDevicePreferences = (listener: () => void): (() => void) => store.subscribe(listener)

export function writeDevicePreferences(patch: Partial<DevicePreferences>): void {
  const current = store.read()
  const next = { ...current, ...patch }
  if ((Object.keys(next) as (keyof DevicePreferences)[]).every((field) => next[field] === current[field])) return
  store.write(next)
}

export function useDevicePreferences(): DevicePreferences {
  return useSyncExternalStore(store.subscribe, store.read, store.read)
}

/** The language: applied to this document first, then stored. */
export function setLocalePreference(next: LocalePreference): void {
  applyLocalePreference(next, true)
  writeDevicePreferences({ locale: next })
}

// The language follows the stored preference when it changes elsewhere (another tab on the web, a read that landed).
store.subscribe(() => {
  const { locale } = store.read()
  if (locale !== getLocaleSnapshot().preference) applyLocalePreference(locale, false)
})

// @@@sidebar-tint the tint is one attribute on <html>: styles/tokens.css rewrites `--sidebar` under it (the session page's
// Shadow DOM inherits the custom property). The boot script set it for the first frame; this follows every change.
store.subscribe(() => {
  if (typeof document === 'undefined') return
  if (store.read().sidebarTint) document.documentElement.setAttribute('data-sidebar-tint', 'on')
  else document.documentElement.removeAttribute('data-sidebar-tint')
})
