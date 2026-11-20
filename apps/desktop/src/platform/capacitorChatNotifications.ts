import { Capacitor, registerPlugin } from '@capacitor/core'
import type { ChatNotificationPresentation } from './types'

// #3416 Android draws a chat message as a conversation (the other person's or the group's face, the real author per
// message) through our native presenter; see GuguChatNotificationsPlugin.java. The renderer has already resolved names
// and faces from the identity directory — nothing here, or in a push payload, looks anyone up.
const native = registerPlugin<{
  show(options: {
    channelId: string
    body: string
    silent: boolean
    accountId: string
    messageId: string
    sentAt: number
    update: boolean
    conversation: ChatNotificationPresentation['conversation']
    author: ChatNotificationPresentation['author']
  }): Promise<{ displayed: boolean }>
  addListener(event: 'opened', listener: (data: Record<string, unknown>) => void): Promise<{ remove: () => Promise<void> }>
}>('GuguChatNotifications')

export const conversationNotificationsAvailable = () =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('GuguChatNotifications')

export async function showConversationNotification(
  payload: { body?: string; silent?: boolean },
  presentation: ChatNotificationPresentation,
  channelId: string,
): Promise<{ success: true; displayed: boolean }> {
  const { displayed } = await native.show({
    channelId,
    body: payload.body ?? '',
    silent: payload.silent === true,
    accountId: presentation.accountId,
    messageId: presentation.messageId,
    sentAt: presentation.sentAt,
    update: presentation.update === true,
    conversation: presentation.conversation,
    author: presentation.author,
  })
  return { success: true, displayed }
}

/** A tap on a conversation notification (a cold-start tap is kept by the plugin until the first listener). */
export function subscribeConversationNotificationTaps(listener: (tap: { chatId: string }) => void): () => void {
  if (!conversationNotificationsAvailable()) return () => undefined
  let active = true
  let handle: { remove: () => Promise<void> } | null = null
  void native.addListener('opened', (data) => {
    if (active && typeof data.chatId === 'string' && data.chatId.length > 0) listener({ chatId: data.chatId })
  }).then(
    (registered) => {
      handle = registered
      if (!active) void registered.remove().catch(() => undefined)
    },
    () => undefined,
  )
  return () => {
    if (!active) return
    active = false
    if (handle) void handle.remove().catch(() => undefined)
  }
}
