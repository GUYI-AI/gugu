import type { Reading } from './replica'
import { devicePreferences, useDevicePreference } from './devicePreferences'

/**
 * @@@5295 托盘数字角标的开关。
 *
 * 归属:app 设置面板 · 通用。角标数是**未读聊天消息**(#6433 起不再加会话页的做完未读),
 * 但它不是通知开关 —— 它是窗口外观(chrome),和「关闭时最小化到托盘」同一类。
 * ❌ 别把它塞进「聊天消息通知」或任务面板的通知卡里:关掉角标不等于关掉通知,反过来也是。
 *
 * 存在 app 设置 `interface.trayBadge` 里;主进程自己读它(❌ 渲染层再推一遍)。
 */
export function setTrayBadgeEnabled(enabled: boolean): void {
  devicePreferences.write('trayBadge', enabled)
}

export function useTrayBadgeEnabled(): Reading<boolean> {
  return useDevicePreference('trayBadge')
}
