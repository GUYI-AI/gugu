import { LOCALE_CHANGED_EVENT, isSupportedLocale, preferHostLanguages, resolveLocale, type LocaleSnapshot } from '../i18n/locale'
import { bootLocalePreference } from '../../shared/device-preferences'
import enUS from '../i18n/locales/en-US/common'
import zhCN from '../i18n/locales/zh-CN/common'

// The HTML startup runs before React. Reuse its locale resolver and catalogs
// without pulling the React i18n provider into this early entry point. The preference comes from this shell's device
// store (shared/device-preferences.ts); a change made while the poster shows arrives as LOCALE_CHANGED_EVENT.
export function mountStartupSlogan(host: HTMLElement): () => void {
  const slogan = document.createElement('p')
  slogan.setAttribute('data-startup-slogan', '')
  const update = (event?: Event) => {
    const detail = (event as CustomEvent<LocaleSnapshot> | undefined)?.detail
    const bridge = window.guguHostLocale
    const hostLanguages = event?.type === 'languagechange' && bridge?.readSystemLanguages
      ? bridge.readSystemLanguages() : bridge?.systemLanguages
    const languages = preferHostLanguages(hostLanguages,
      navigator.languages?.length ? navigator.languages : [navigator.language])
    const locale = isSupportedLocale(detail?.resolvedLocale) ? detail.resolvedLocale
      : resolveLocale(bootLocalePreference(window), languages)
    slogan.lang = locale
    slogan.textContent = { 'zh-CN': zhCN, 'en-US': enUS }[locale].startup.slogan
  }
  update()
  host.append(slogan)
  window.addEventListener(LOCALE_CHANGED_EVENT, update)
  window.addEventListener('languagechange', update)
  return () => {
    slogan.remove()
    window.removeEventListener(LOCALE_CHANGED_EVENT, update)
    window.removeEventListener('languagechange', update)
  }
}
