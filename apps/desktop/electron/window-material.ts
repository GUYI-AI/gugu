import {
  WINDOW_MATERIAL_CHANGED_CHANNEL,
  WINDOW_MATERIAL_GET_CHANNEL,
  SYSTEM_APPEARANCE_CHANNEL,
  isThemePreferenceValue,
  resolveWindowMaterial,
  type WindowMaterial,
} from '../shared/window-material'
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

/** `electron.nativeTheme` 里同步原生外观要用的两项。 */
export interface NativeAppearanceTheme {
  themeSource: 'system' | 'light' | 'dark'
  readonly shouldUseDarkColors: boolean
}

/**
 * @@@native-appearance (#7333) — 只在 mac 上把偏好照抄成 themeSource(原生材质只有 mac 有;Windows/Linux 的托盘图标
 * 读 shouldUseDarkColors 跟任务栏走,不能被咕咕的手选主题带偏)。偏好来自 app 设置 `theme`,由主进程自己读
 * (启动时、这个键变了时,main.ts);认不出的偏好响亮报错,❌ 悄悄当成 system。
 */
export function applyNativeThemePreference(platform: NodeJS.Platform, theme: NativeAppearanceTheme, preference: unknown): void {
  if (!isThemePreferenceValue(preference)) throw new Error(`theme preference must be light / dark / system, got ${JSON.stringify(preference)}`)
  if (platform === 'darwin' && theme.themeSource !== preference) theme.themeSource = preference
}

/**
 * The system's own appearance, whatever Gugu's choice. Off macOS themeSource is never set, so shouldUseDarkColors is the
 * system's. On macOS it is too while themeSource is 'system'; while a hand-pick holds it, the system's appearance is
 * the user default AppleInterfaceStyle ('Dark' while dark, also under automatic switching).
 */
export function systemAppearance(platform: NodeJS.Platform, theme: NativeAppearanceTheme, macInterfaceStyle: () => string): 'light' | 'dark' {
  if (platform !== 'darwin' || theme.themeSource === 'system') return theme.shouldUseDarkColors ? 'dark' : 'light'
  return macInterfaceStyle() === 'Dark' ? 'dark' : 'light'
}

/** 纯读:renderer 解析「跟随系统」时同步问一次系统此刻的明暗(首帧前也要用)。 */
export function installSystemAppearanceRead(deps: {
  platform: NodeJS.Platform
  nativeTheme: NativeAppearanceTheme
  macInterfaceStyle: () => string
  ipcMain: WindowMaterialIpc
}): void {
  deps.ipcMain.on(SYSTEM_APPEARANCE_CHANNEL, (event) => {
    try {
      event.returnValue = systemAppearance(deps.platform, deps.nativeTheme, deps.macInterfaceStyle)
    } catch (error) {
      // 同步 IPC 不能抛给 renderer(它会一直等 returnValue):记下来,答一个明确的空值,renderer 据此说出来。
      logger.error({ error: String(error) }, '读不到系统外观')
      event.returnValue = null
    }
  })
}
