import { resolveLocale, type SupportedLocale } from '@/i18n/locale'
import type { LocalePreference } from '../shared/device-preferences'

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
