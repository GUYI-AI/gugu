/**
 * @@@window-material (#7333) — 窗口底层材质的唯一判定:主进程读系统信号,renderer 只消费结论。
 *
 * 只有 mac 主窗带系统材质(electron/main.ts 的 `vibrancy`);它要被看见,renderer 得把导航那几层的底色让出来。
 * 让不让由这里一个函数说了算,写到 `<html data-window-material>` 上:
 *   native — 系统材质在、且用户没开「减弱透明度」「增强对比度」⇒ rail 与侧栏透出材质;
 *   opaque — 其余一切情况 ⇒ 全部不透明表面。
 * ❌ renderer 按平台名自己猜:平台是 mac 不代表材质可见(减弱透明度开着时系统会把材质画成实色,
 *    renderer 再透一层就是一块灰底)。dev:web / 手机没有主进程,属性缺省即 opaque —— 那是它们的真实状态。
 */
export type WindowMaterial = 'native' | 'opaque'

/** 主进程每次重算时读的系统信号。都来自 `nativeTheme`,❌ 从 renderer 回传。 */
export interface WindowMaterialSignals {
  platform: NodeJS.Platform
  prefersReducedTransparency: boolean
  highContrast: boolean
}

export function resolveWindowMaterial(signals: WindowMaterialSignals): WindowMaterial {
  if (signals.platform !== 'darwin') return 'opaque'
  if (signals.prefersReducedTransparency || signals.highContrast) return 'opaque'
  return 'native'
}

export const WINDOW_MATERIAL_GET_CHANNEL = 'window-material:get'
export const WINDOW_MATERIAL_CHANGED_CHANNEL = 'window-material:changed'

/**
 * @@@native-appearance (#7333) — mac 上原生材质的明暗跟着 `nativeTheme.themeSource` 走,而不是跟着咕咕自己的
 * `<html data-theme>`。用户在咕咕里手选的主题与系统外观相反时,透出来的就会是「浅材质配浅字」。
 * ⇒ 主进程自己照抄**偏好**(light / dark / system,app 设置 `theme`)成 themeSource:启动时、`theme` 变了时
 * (@@@device-preferences:主进程是这份偏好的持有者,❌ renderer 每次再推一遍)。
 * ❌ 把解析后的明暗写成 themeSource:那会把「跟随系统」变成永久手选。
 *
 * renderer 仍要同步知道一件事:**系统**此刻是深是浅(选「跟随系统」那一帧就要画对)。mac 上 themeSource 还停在上一次
 * 手选时,Chromium 的 prefers-color-scheme 说的是那个手选,不是系统 ⇒ 问主进程(SYSTEM_APPEARANCE_CHANNEL,纯读)。
 */
export type ThemePreferenceValue = 'light' | 'dark' | 'system'
export const SYSTEM_APPEARANCE_CHANNEL = 'window:system-appearance'

export function isThemePreferenceValue(value: unknown): value is ThemePreferenceValue {
  return value === 'light' || value === 'dark' || value === 'system'
}
