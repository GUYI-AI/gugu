import { LOCALE_CHANGED_EVENT, LOCALE_STORAGE_KEY, isSupportedLocale, preferHostLanguages, readLocalePreference, resolveLocale, type LocaleSnapshot } from '../i18n/locale'
import enUS from '../i18n/locales/en-US/common'
import zhCN from '../i18n/locales/zh-CN/common'

// The HTML startup runs before React. Reuse its locale resolver and catalogs
// without pulling the React i18n provider into this early entry point.
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
      : resolveLocale(readLocalePreference(window.localStorage), languages)
    slogan.lang = locale
    slogan.textContent = { 'zh-CN': zhCN, 'en-US': enUS }[locale].startup.slogan
  }
  const onStorage = (event: StorageEvent) => { if (event.key === LOCALE_STORAGE_KEY || event.key === null) update() }
  update()
  host.append(slogan)
  window.addEventListener(LOCALE_CHANGED_EVENT, update)
  window.addEventListener('languagechange', update)
  window.addEventListener('storage', onStorage)
  return () => {
    slogan.remove()
    window.removeEventListener(LOCALE_CHANGED_EVENT, update)
    window.removeEventListener('languagechange', update)
    window.removeEventListener('storage', onStorage)
  }
}
