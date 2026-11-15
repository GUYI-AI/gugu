import type { Reading } from './replica'
import { devicePreferences, useDevicePreference } from './devicePreferences'
import type { ChatNotifications } from '../../shared/device-preferences'

/**
 * @@@5301 app 设置面板这一侧的通知开关。**只管咕咕主界面这条链**（聊天新消息）；会话页 agent 的通知是另一条完全独立的链，归任务设置面板，
 * 落在 `electron/session/main/core/agent-hooks/notification.ts`。两个面板是既定结构，
 * ❌ 不要把这两套开关合并。
 *
 * 字段按**来源**切，不按状态切：用户能分辨的是「这条是谁发来的」，不是「它处于什么状态」。
 *  - `chatMessages` 聊天消息：私聊新消息、群里叫到你的消息（判据见 notificationModels.shouldNotify）。
 *  - `sound` 提示音：聊天系统横幅响不响。
 *
 * 存在这台设备的偏好里(lib/devicePreferences.ts:桌面 = app 设置 `chatNotifications`,web / 手机 = localStorage)。
 * 旧结构 `{ messages, requests }` 的 `messages` 在读旧值时认一次(shared/device-preferences.ts)。
 */
export type NotificationSettings = ChatNotifications

/**
 * What a notification decides with, this moment. Before the preference is read (only if the desktop handover failed)
 * nothing announces: the person may have turned it off.
 */
function decision(reading: Reading<NotificationSettings>): NotificationSettings {
  // @@@reading-default - whether to announce a message arriving before the preference was read: neither banner nor sound
  return reading.state === 'value' ? reading.value : { chatMessages: false, sound: false }
}

/** For the decision to announce (outside React). */
export function readNotificationSettings(): NotificationSettings {
  return decision(devicePreferences.read('chatNotifications'))
}

export function setNotificationSettings(patch: Partial<NotificationSettings>): void {
  const reading = devicePreferences.read('chatNotifications')
  if (reading.state !== 'value') throw new Error('chat notifications: not read yet')
  devicePreferences.write('chatNotifications', { ...reading.value, ...patch })
}

export function subscribeNotificationSettings(listener: () => void): () => void {
  return devicePreferences.subscribe(listener)
}

/** The settings page's switches. */
export function useNotificationSettingsReading(): Reading<NotificationSettings> {
  return useDevicePreference('chatNotifications')
}

/** For the decision to announce, followed by the chat store (it announces; it draws nothing of it). */
export function useNotificationSettings(): NotificationSettings {
  return decision(useDevicePreference('chatNotifications'))
}
