import { resolveLocale, type SupportedLocale } from '@/i18n/locale'
import type { LocalePreference } from '../shared/device-preferences'
import { hostCatalog, type HostCatalog } from '../shared/host-localization'

/**
 * @@@device-preferences — the host's language (tray, menus, window chrome, the session page's copy): resolved by main from
 * the stored language preference and the system's own languages (app.getPreferredSystemLanguages()), the same rule the
 * renderer resolves with. Until the settings are read at startup it follows the system.
 */
export class HostLocaleStore {
  private locale: SupportedLocale
  private preference: LocalePreference = 'system'

  constructor(private readonly systemLanguages: () => readonly string[]) {
    this.locale = resolveLocale('system', systemLanguages())
  }

  current(): SupportedLocale {
    return this.locale
  }

  /** Resolve again (the preference changed, or the system's languages may have); true when the language changed. */
  apply(preference: LocalePreference = this.preference): boolean {
    this.preference = preference
    const before = this.locale
    this.locale = resolveLocale(preference, this.systemLanguages())
    return this.locale !== before
  }
}

/**
 * @@@host-copy — the one host locale store of this process, installed by main at startup. Main-process modules that
 * write text a person reads (dialogs, notifications, errors the renderer shows as the device's own words) take it from
 * `hostCopy()`, in the host's language. Not installed means wiring is broken ⇒ throw; ❌ fall back to one language.
 */
let installed: HostLocaleStore | null = null

export function installHostLocaleStore(store: HostLocaleStore): void {
  installed = store
}

/** Main's window-focus hook can fire before startup installs the store. */
export function hostLocaleInstalled(): boolean {
  return installed !== null
}

export function hostLocaleStore(): HostLocaleStore {
  if (!installed) throw new Error('HOST_LOCALE_NOT_INITIALIZED')
  return installed
}

export function hostCopy(): HostCatalog {
  return hostCatalog(hostLocaleStore().current())
}
