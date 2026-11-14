// @@@mobile-shell-chrome — 安卓壳的系统状态栏、导航栏底下那块是壳的(MobileShellChrome.java),跟页面的色调走。
// 主题真值只有 `<html data-theme>`(host-theme.ts 是唯一写入者),壳问不到 ⇒ 这里观察属性、开机同步一次、每次变了再告诉它,
// 和桌面告诉主进程窗口色调(@@@window-tone)同一个形状。
import { Capacitor, registerPlugin } from '@capacitor/core'
import { readEffectiveHostTheme, readThemePreference, subscribeToHostTheme, subscribeToThemePreference } from '../session/renderer/lib/theme/host-theme'
import { rendererLogger } from '../lib/log'

const log = rendererLogger('mobile/shell-chrome')
const shellChrome = registerPlugin<{ syncTone(options: { tone: 'light' | 'dark'; preference: 'light' | 'dark' | 'system' }): Promise<void> }>('GuguShellChrome')

export function startShellChromeTone(): void {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('GuguShellChrome')) return
  const sync = () => {
    const tone = readEffectiveHostTheme()
    shellChrome.syncTone({ tone, preference: readThemePreference() }).catch((error: unknown) => log.error({ tone, error: String(error) }, 'the system bars did not take the page tone'))
  }
  sync()
  subscribeToHostTheme(sync)
  subscribeToThemePreference(sync)
}

// The iOS WebView sits inside a native safe-area container. Painting the web overlay
// cannot reach the status bar or home-indicator margins; lease their native appearance.
const imageViewerChrome = registerPlugin<{ setActive(options: { active: boolean }): Promise<void> }>('GuguImageViewerChrome')
export function holdIOSImageViewerChrome(): () => void {
  if (Capacitor.getPlatform() !== 'ios' || !Capacitor.isPluginAvailable('GuguImageViewerChrome')) return () => {}
  const sync = (active: boolean) => imageViewerChrome.setActive({ active }).catch((error: unknown) =>
    log.error({ error: String(error) }, 'image viewer system chrome did not update'))
  const opened = sync(true)
  return () => { void opened.then(() => sync(false)) }
}
