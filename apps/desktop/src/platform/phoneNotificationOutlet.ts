import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications'
import type { AppPlatform } from './types'

let notificationSeq = Math.floor(Date.now() / 1000) % 1_000_000_000

/** Shared OS outlet for chat/agent decisions and explicit tests on both phones. */
export async function schedulePhoneNotification(
  payload: Parameters<AppPlatform['showNotification']>[0],
  options: Pick<LocalNotificationSchema, 'channelId' | 'foreground' | 'isExactNotification' | 'sound'>,
): Promise<{ success: true; displayed: true }> {
  notificationSeq = (notificationSeq + 1) % 2_147_483_647
  await LocalNotifications.schedule({ notifications: [{
    id: notificationSeq, title: payload.title, body: payload.body ?? '',
    ...options,
    extra: payload.chatId ? { chatId: payload.chatId } : undefined,
  }] })
  return { success: true, displayed: true }
}
