// #7199 「灵感」入口:输入框上方那颗「灵感」胶囊能隐藏,隐藏后「+」里的「获取灵感」照样在。
// 隐藏了哪些助理的入口记在这台设备的偏好里(lib/devicePreferences.ts:桌面 = app 设置 `assistant.hiddenIdeasEntries`;
// 助理 id 全局唯一,不需要再按账号分),不同步到云。
import type { Reading } from './replica'
import { devicePreferences, useDevicePreference } from './devicePreferences'

export function setIdeasEntryHidden(assistantId: string, hidden: boolean): void {
  const reading = devicePreferences.read('hiddenIdeasEntries')
  if (reading.state !== 'value') throw new Error('hidden ideas entries: not read yet')
  const rest = reading.value.filter((id) => id !== assistantId)
  devicePreferences.write('hiddenIdeasEntries', hidden ? [...rest, assistantId] : rest)
}

export function useIdeasEntryHidden(assistantId: string): Reading<boolean> {
  const reading = useDevicePreference('hiddenIdeasEntries')
  return reading.state === 'value' ? { ...reading, value: reading.value.includes(assistantId) } : reading
}
