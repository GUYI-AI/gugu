import { useSyncExternalStore } from 'react'

let confirmed = false
const listeners = new Set<() => void>()
export const androidPushConfirmed = (): boolean => confirmed
export const subscribeAndroidPush = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener) }
export function setAndroidPushConfirmed(next: boolean): void {
  if (confirmed === next) return
  confirmed = next; listeners.forEach(listener => listener())
}
export const useAndroidPushConfirmed = (): boolean => useSyncExternalStore(subscribeAndroidPush, androidPushConfirmed, () => false)
export const suppressAndroidLocalPushNotification = (remoteConfirmed: boolean, appActive: boolean, chatId: string | null | undefined, kind?: 'chat_message' | 'task_attention'): boolean =>
  remoteConfirmed && !appActive && (Boolean(chatId) || kind === 'task_attention')
