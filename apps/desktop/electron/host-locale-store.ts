import { resolveLocale, type LocalePreference, type SupportedLocale } from '@/i18n/locale'

/** @@@device-preferences — the host's language, resolved by main from the `locale` setting (❌ a copy on disk, ❌ renderer-pushed); system until readable. */
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
