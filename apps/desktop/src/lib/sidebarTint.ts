import type { Reading } from './replica'
import { devicePreferences, useDevicePreference } from './devicePreferences'

/**
 * @@@sidebar-tint owner 2026-09-10：三栏应该是一条底色阶梯 —— 最左的功能栏最深、中间的
 * 会话/任务列表居中、右边的消息区最浅。浅色主题下中间那一档是缺席的(`--sidebar` 就是 #fff,
 * 与消息区一模一样),于是列表和内容糊成一片。这个开关把中间那一档补上。
 *
 * **默认关**：关着的时候今天的界面一个像素都不动,颜色只在打开后才换。
 *
 * 真值落在 `<html data-sidebar-tint="on">` 上,颜色本身在 styles/tokens.css 里只改写
 * `--sidebar` 一个 token —— 会话列表 / 通讯录 / 设置导航(`.gg-pane[data-role='nav']`)与
 * 会话页左栏(皮肤桥的 `.bg-background-tertiary` + `--em-background-secondary`)本来就都吃
 * 这一个 token,所以一处到位。会话页那棵 Shadow DOM 靠自定义属性的继承拿到同一个值,
 * ❌ 不需要第二条同步链。
 *
 * 存在这台设备的偏好里(lib/devicePreferences.ts);首帧之前由 index.html 的引导脚本按同一份值落一次属性(❌ 先闪白底)。
 */
const ATTRIBUTE = 'data-sidebar-tint'
const ATTRIBUTE_ON = 'on'

/** 把开关的值落到 `<html>` 属性上 —— 上色的唯一出口。还没读到(只在桌面交接失败时)= 不动属性。 */
function applySidebarTint(): void {
  if (typeof document === 'undefined') return
  const reading = devicePreferences.read('sidebarTint')
  if (reading.state !== 'value') return
  if (reading.value) document.documentElement.setAttribute(ATTRIBUTE, ATTRIBUTE_ON)
  else document.documentElement.removeAttribute(ATTRIBUTE)
}

export function setSidebarTintEnabled(enabled: boolean): void {
  devicePreferences.write('sidebarTint', enabled)
}

let following = false

/** 属性跟着偏好走(本窗口改的、别的窗口改的):整个文档一份,幂等。 */
export function hydrateSidebarTint(): void {
  if (!following) {
    following = true
    devicePreferences.subscribe(applySidebarTint)
  }
  applySidebarTint()
}

export function useSidebarTintEnabled(): Reading<boolean> {
  return useDevicePreference('sidebarTint')
}
