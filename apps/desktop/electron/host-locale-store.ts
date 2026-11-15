import { resolveLocale, type LocalePreference, type SupportedLocale } from '@/i18n/locale'

/**
 * @@@device-preferences — the host's language (tray, menus, window chrome, the session host's copy). Main resolves it
 * itself from the `locale` app setting and the system's languages (main.ts `applyHostLocale`): at startup, when the
 * setting changes, and when the app comes back to the foreground (the system's languages may have changed meanwhile).
 * ❌ a copy of its own on disk, ❌ the renderer pushing what it resolved: the setting is the one store.
 * Until the settings are readable (the session backend loads after the window is created, hidden) it follows the system.
 */
export class HostLocaleStore {
  private locale: SupportedLocale

  constructor(systemLanguages: readonly string[]) {
    this.locale = resolveLocale('system', systemLanguages)
  }

  current(): SupportedLocale {
    return this.locale
  }

  /** Resolve a preference against the system's languages; returns whether the host's language changed. */
  apply(preference: LocalePreference, systemLanguages: readonly string[]): boolean {
    const next = resolveLocale(preference, systemLanguages)
    if (next === this.locale) return false
    this.locale = next
    return true
  }
}
