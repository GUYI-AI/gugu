import {
  WINDOW_MATERIAL_CHANGED_CHANNEL,
  WINDOW_MATERIAL_GET_CHANNEL,
  resolveWindowMaterial,
  type WindowMaterial,
} from '../shared/window-material'
import type { ThemePreference } from '../shared/device-preferences'
import { createLogger } from './lib/logger'

const logger = createLogger('window-material')

/**
 * @@@window-material (#7333) — 主进程这一侧:读系统信号 → 判定 → 同步答 renderer 的首帧询问 → 信号变了推过去。
 * 判定本身在 shared/window-material.ts(纯函数);这里只接线,依赖全部注入(main.ts 传 Electron 的真对象,
 * 单测传假的 —— 负例在单测里模拟,❌ 在产品主进程里留测试开关)。
 * 材质是**某一扇窗**的属性:只有建窗时挂了 vibrancy、且底色让出来的那扇(mac 主窗)才可能是 native;
 * 别的窗(子窗口、快速聊天小窗)一律答 opaque,❌ 把「mac + 系统允许」当成所有窗口的结论广播。
 */
export interface WindowMaterialHost {
  current(): WindowMaterial
  /** 判定变了才回调(nativeTheme 的 updated 也会因深浅色切换触发,那时材质没变,不回调)。 */
  onChange(listener: (material: WindowMaterial) => void): () => void
}

/** `electron.nativeTheme` 里用得到的那几项。 */
export interface WindowMaterialTheme {
  readonly prefersReducedTransparency: boolean
  readonly shouldUseHighContrastColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

/** `electron.ipcMain` 里用得到的那一项:同步询问。 */
export interface WindowMaterialIpc {
  on(channel: string, listener: (event: { sender: unknown; returnValue: unknown }, ...args: unknown[]) => void): unknown
}

/** 挂了 vibrancy 的那扇窗(mac 主窗);没有这样的窗时返回 null。 */
export interface WindowMaterialWindow {
  isDestroyed(): boolean
  readonly webContents: { send(channel: string, ...args: unknown[]): void }
}

export interface WindowMaterialDeps {
  platform: NodeJS.Platform
  nativeTheme: WindowMaterialTheme
  ipcMain: WindowMaterialIpc
  materialWindow: () => WindowMaterialWindow | null
}

export function installWindowMaterial({ platform, nativeTheme, ipcMain, materialWindow }: WindowMaterialDeps): WindowMaterialHost {
  const decide = (): WindowMaterial =>
    resolveWindowMaterial({
      platform,
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
      highContrast: nativeTheme.shouldUseHighContrastColors,
    })
  // 证据里要看得出这次判定读到的真实系统值,所以两个信号原样进日志。
  const record = (message: string): void => {
    logger.info(
      {
        material,
        prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
        highContrast: nativeTheme.shouldUseHighContrastColors,
      },
      message,
    )
  }
  let material = decide()
  const listeners = new Set<(material: WindowMaterial) => void>()
  record('窗口材质判定')

  const isMaterialWindow = (sender: unknown): boolean => {
    const win = materialWindow()
    return !!win && !win.isDestroyed() && win.webContents === sender
  }
  ipcMain.on(WINDOW_MATERIAL_GET_CHANNEL, (event) => {
    event.returnValue = isMaterialWindow(event.sender) ? material : 'opaque'
  })

  nativeTheme.on('updated', () => {
    const next = decide()
    if (next === material) return
    material = next
    record('窗口材质判定变化')
    const win = materialWindow()
    if (win && !win.isDestroyed()) win.webContents.send(WINDOW_MATERIAL_CHANGED_CHANNEL, material)
    for (const listener of listeners) listener(material)
  })

  return {
    // 主进程里只有底色同步读它,而那一处已经按窗口分了(只给 mac 主窗写透明底色)。
    current: () => material,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** `electron.nativeTheme` 里同步原生外观要用的那一项。 */
export interface NativeAppearanceTheme {
  themeSource: 'system' | 'light' | 'dark'
}

/**
 * @@@native-appearance (#7333) — mac 上原生材质的明暗跟着 `nativeTheme.themeSource` 走,而不是跟着咕咕自己的
 * `<html data-theme>`:用户手选的主题与系统外观相反时,透出来的就会是「浅材质配浅字」。⇒ 主进程按自己存的主题偏好
 * (@@@device-preferences)照抄成 themeSource,启动时一次、偏好每次变化时一次。只在 mac 上抄(原生材质只有 mac 有;
 * Windows/Linux 的托盘图标读 shouldUseDarkColors 跟任务栏走,不能被咕咕的手选主题带偏)。
 * ❌ 把解析后的明暗写成 themeSource:那会把「跟随系统」变成永久手选,renderer 读系统外观的 matchMedia 也跟着失真。
 */
export function applyNativeThemePreference(platform: NodeJS.Platform, theme: NativeAppearanceTheme, preference: ThemePreference): void {
  if (platform === 'darwin' && theme.themeSource !== preference) theme.themeSource = preference
}
