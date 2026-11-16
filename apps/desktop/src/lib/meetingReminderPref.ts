// #7199 「入会提醒」开关(默认开):记在这台电脑上 —— 提醒读的就是这台电脑的日历。
// 存在这台设备的偏好里(lib/devicePreferences.ts:桌面 = app 设置 `assistant.meetingReminder`);壳(提醒卡)与会话页
// (助理的设置页)读同一份,任一窗口改了,别的跟着变。
import type { Reading } from './replica'
import { devicePreferences, useDevicePreference } from './devicePreferences'

/** 提醒这一刻要不要弹(一次性的判断)。 */
export function meetingReminderEnabled(): boolean {
  const reading = devicePreferences.read('meetingReminder')
  // @@@reading-default(moment) - a reminder decided before the preference was read (only if the desktop handover failed): not shown; the next one asks again
  return reading.state === 'value' && reading.value
}

export function setMeetingReminderEnabled(on: boolean): void {
  devicePreferences.write('meetingReminder', on)
}

export function useMeetingReminderPref(): Reading<boolean> {
  return useDevicePreference('meetingReminder')
}
