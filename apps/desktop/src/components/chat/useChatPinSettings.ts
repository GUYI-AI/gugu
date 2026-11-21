import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { readChatPinSettings, setChatPinPreference, watchChatPinSettings, type ChatPinSettings } from '@/lib/chatPinSettings'
import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import { queryClient, replica, useReplica } from '@/lib/replica'
import { useAuth } from '@/store/auth'
import { useToast } from '../toastContext'

/** The topics this account pinned in a chat (its own settings row per chat); a change elsewhere arrives by the watch. */
export const chatPins = replica({
  name: 'chatPins',
  scope: 'account',
  read: (owner: string, chatId: string): Promise<ChatPinSettings> => readChatPinSettings(owner, chatId),
  // Pushed: a value stays current until the watch says otherwise (the watch reads once more when it starts).
  fresh: Infinity,
  // Back in the app after having left: read again (❌ on every focus of the main window: switching Gugu windows).
  refreshOnFocus: true,
  watch: { group: (chatId) => chatId, start: (owner, chatId) => watchChatPinSettings(owner, chatId, () => { void chatPins.refresh(chatId) }) },
})

const NO_PINS: readonly string[] = []

export function useChatPinSettings(chatId: string | null, enabled = true) {
  const { user } = useAuth()
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const userId = user?.id
  const reading = useReplica(chatPins, userId && chatId && enabled ? [chatId] : null)
  const mutation = useMutation({
    networkMode: 'always', scope: { id: `chat-settings:${userId}:${chatId}` },
    mutationFn: async (input: { userId: string | undefined; chatId: string | null; id: string; pinned: boolean }) => {
      if (!input.userId || !input.chatId) throw new Error('A signed-in chat is required')
      const entry = chatPins.at(input.chatId)
      const pins = await setChatPinPreference(input.userId, input.chatId, input.id, input.pinned)
      entry.set(pins)
      return pins
    },
    onError: (error) => { rendererLogger('chat/pins').error({ error }, 'Saving chat pins failed'); toast(t('topic.pins.saveFailed'), 'error', messageForUser(error)) },
  }, queryClient)
  const topicIds = reading.state === 'value' ? reading.value.topicIds : NO_PINS
  return {
    topicIds,
    ready: reading.state === 'value', error: reading.state === 'error', saving: mutation.isPending,
    retry: () => { if (chatId) void chatPins.refresh(chatId) },
    set: (id: string, pinned: boolean) => mutation.mutate({ userId, chatId, id, pinned }),
  }
}
