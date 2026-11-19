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

