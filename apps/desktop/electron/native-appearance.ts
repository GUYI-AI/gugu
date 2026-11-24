import type { ThemePreference } from '../shared/device-preferences'

/** `electron.nativeTheme` 里同步原生外观要用的那一项。 */
export interface NativeAppearanceTheme {
  themeSource: 'system' | 'light' | 'dark'
}

/**
 * @@@native-appearance (#7333) — mac 上由系统替这扇窗画的东西(窗口外框、原生菜单与对话框)的明暗跟着
 * `nativeTheme.themeSource` 走,而不是跟着咕咕自己的 `<html data-theme>`:用户手选的主题与系统外观相反时,
 * 它们就和界面对不上。⇒ 主进程按自己存的主题偏好(@@@device-preferences)照抄成 themeSource,启动时一次、
 * 偏好每次变化时一次。只在 mac 上抄(Windows/Linux 的托盘图标读 shouldUseDarkColors 跟任务栏走,
 * 不能被咕咕的手选主题带偏)。
 * ❌ 把解析后的明暗写成 themeSource:那会把「跟随系统」变成永久手选,renderer 读系统外观的 matchMedia 也跟着失真。
 */
export function applyNativeThemePreference(platform: NodeJS.Platform, theme: NativeAppearanceTheme, preference: ThemePreference): void {
  if (platform === 'darwin' && theme.themeSource !== preference) theme.themeSource = preference
}
