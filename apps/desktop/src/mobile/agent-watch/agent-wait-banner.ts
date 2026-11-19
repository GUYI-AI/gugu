import { platform } from '@/platform'
import { readNotificationSettings } from '@/lib/notificationSettings'

/**
 * 「agent 在等你」怎么送到人眼前 —— **只有一个通道:系统横幅**,不分 App 在不在前台。
 *
 * owner 2026-09-15:「其实你就统一一下,都用系统横幅不行吗?没必要搞什么 App 内的提示条,
 * 尤其是在手机端,我觉得完全没必要。……总之就是,你把话搞复杂了」。
 * ⇒ ❌ 不要再给提醒加第二个通道(App 内提示条、列表红点、未读角标)。这个功能有几个通道,
 * 判据就是几:超过一个就是设计复杂了。
 *
 * 安卓 App 走原生通知(WebView 没有网页 `Notification` 接口,MDN browser-compat-data:
 * webview_android 未实现);浏览器宿主走网页 Notification。两条都是同一个东西的不同实现,
 * 不是两个通道。发不出去(用户没给通知权限)就没有提醒 —— 那正是「我的 → 权限」那一页要解决的事。
 *
 * 手机的看管(useAgentWatchAlerts)与桌面对别的机器的会话列表(remote-hosts-store `bannerWaits`)都从这里发:
 * 同一件事(一条会话停下来等你)只有这一个出口。`silent` 缺省照聊天横幅的声音开关;桌面传它自己的 agent 通知开关。
 */
export async function announceAgentWait(text: string, silent = !readNotificationSettings().sound): Promise<void> {
  // The desktop's banner is its main process's (on every OS); a phone's is its native outlet.
  if (platform.kind === 'electron' || platform.systemPermissions.includes('notifications')) {
    void platform.showNotification({ title: text, chatId: null, silent }).catch(() => undefined)
    return
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(text, { silent })
  } catch {
    // 通知发不出去不该把看管页拖垮（部分浏览器在非安全上下文里直接抛）。
  }
}
