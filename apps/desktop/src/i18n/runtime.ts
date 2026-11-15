import { createInstance, type Resource, type ResourceKey } from 'i18next'
import { initReactI18next } from 'react-i18next'
import enUSCommon from './locales/en-US/common'
import zhCNCommon from './locales/zh-CN/common'
import { devicePreferences } from '../lib/devicePreferences'
import { bootLocalePreference } from '../../shared/device-preferences'
import {
  FALLBACK_LOCALE,
  LOCALE_CHANGED_EVENT,
  isLocalePreference,
  isSupportedLocale,
  preferHostLanguages,
  resolveLocale,
  type LocalePreference,
  type LocaleSnapshot,
  type SupportedLocale,
} from './locale'

type LocaleCatalog = Record<SupportedLocale, ResourceKey>
type LocaleChangeDetail = LocaleSnapshot

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

// 桌面宿主经 preload 同步注入真实系统语言;web/移动端没有该注入,退回 navigator。
// `refresh` 用于宿主语言可能已经变了的时机(languagechange):首帧那份是 preload 时刻的快照,
// 不重新问宿主的话「跟随系统」在桌面上就只能靠重启才更新。
function hostLanguages(refresh = false): readonly string[] {
  const bridge = typeof window === 'undefined' ? null : window.guguHostLocale
  const injected = refresh && bridge?.readSystemLanguages
    ? bridge.readSystemLanguages()
    : bridge?.systemLanguages
  return preferHostLanguages(injected, navigatorLanguages())
}

/**
 * The language preference lives in this shell's device store (lib/devicePreferences.ts). Its first value is read here
 * with the dependency-free boot reader — the same store: on desktop preload's handover (the settings replica's first
 * value too), so the language is right from the first frame, the upgrade start included; on web / phone localStorage.
 * ❌ `devicePreferences` at module evaluation: its chain (settings client → ipc → machine clients) imports this module.
 */
const preference = typeof window === 'undefined' ? 'system' : bootLocalePreference(window)
let snapshot: LocaleSnapshot = {
  preference,
  resolvedLocale: resolveLocale(preference, hostLanguages()),
}

const resources: Resource = {
  'zh-CN': { common: zhCNCommon },
  'en-US': { common: enUSCommon },
}

export const i18n = createInstance()

void i18n.use(initReactI18next).init({
  resources,
  lng: snapshot.resolvedLocale,
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: ['zh-CN', 'en-US'],
  defaultNS: 'common',
  ns: ['common'],
  interpolation: { escapeValue: false },
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
})

const listeners = new Set<() => void>()

function applySnapshot(next: LocaleSnapshot, broadcast: boolean): void {
  if (
    snapshot.preference === next.preference
    && snapshot.resolvedLocale === next.resolvedLocale
  ) return

  snapshot = next
  void i18n.changeLanguage(next.resolvedLocale)
  if (typeof document !== 'undefined') document.documentElement.lang = next.resolvedLocale
  for (const listener of listeners) listener()

  if (broadcast && typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
    window.dispatchEvent(new CustomEvent<LocaleChangeDetail>(LOCALE_CHANGED_EVENT, { detail: next }))
  }
}

if (typeof document !== 'undefined') document.documentElement.lang = snapshot.resolvedLocale

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (snapshot.preference !== 'system') return
    applySnapshot({
      preference: 'system',
      resolvedLocale: resolveLocale('system', hostLanguages(true)),
    }, true)
  })


  window.addEventListener(LOCALE_CHANGED_EVENT, (event) => {
    const detail = (event as CustomEvent<LocaleChangeDetail>).detail
    if (!detail || !isLocalePreference(detail.preference)) return
    // 采用发起方已经解析好的 locale。❌ 别按本地快照重算:languagechange 会向宿主重新问语言,
    // 而这里的重算只看首帧快照 —— 于是自己广播的新语言被自己用旧快照盖回旧值(实测过)。
    applySnapshot({
      preference: detail.preference,
      resolvedLocale: isSupportedLocale(detail.resolvedLocale)
        ? detail.resolvedLocale
        : resolveLocale(detail.preference, hostLanguages()),
    }, false)
  })
}

export function getLocaleSnapshot(): LocaleSnapshot {
  return snapshot
}

let following = false

/** Changed elsewhere (another window, another tab of the web page, its first read after a failed handover). */
function followStoredPreference(): void {
  if (following) return
  following = true
  devicePreferences.subscribe(() => {
    const reading = devicePreferences.read('locale')
    if (reading.state !== 'value' || reading.value === snapshot.preference) return
    applySnapshot({ preference: reading.value, resolvedLocale: resolveLocale(reading.value, hostLanguages()) }, false)
  })
}

export function subscribeLocale(listener: () => void): () => void {
  // Installed with the first subscriber (every entry's LocalizationProvider), after the module graph has evaluated.
  followStoredPreference()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setLocalePreference(next: LocalePreference): void {
  if (!isLocalePreference(next)) throw new Error(`Unsupported locale preference: ${String(next)}`)
  // Applied first: the follower above then finds its own write already in place.
  applySnapshot({
    preference: next,
    resolvedLocale: resolveLocale(next, hostLanguages()),
  }, true)
  devicePreferences.write('locale', next)
}

export function registerLocaleNamespace(namespace: string, catalog: LocaleCatalog): void {
  for (const locale of ['zh-CN', 'en-US'] as const) {
    i18n.addResourceBundle(locale, namespace, catalog[locale], true, true)
  }
}
