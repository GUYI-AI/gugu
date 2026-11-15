import { useEffect } from 'react'
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
})

const NO_PINS: readonly string[] = []
// Subscription ownership only; the pins live in the replica.
const watches = new Map<string, { users: number; stop: () => void }>()

function watch(userId: string, chatId: string) {
  const id = JSON.stringify([userId, chatId])
  let entry = watches.get(id)
  if (!entry) {
    const stop = watchChatPinSettings(userId, chatId, () => { void chatPins.refresh(chatId) })
    // The kept pins paint the first frame; changes made while nobody watched are read again now.
    if (chatPins.peek(chatId).state === 'value') void chatPins.refresh(chatId)
    entry = { users: 0, stop }
    watches.set(id, entry)
  }
  const active = entry
  active.users++
  return () => {
    if (--active.users === 0) { active.stop(); watches.delete(id) }
  }
}

export function useChatPinSettings(chatId: string | null, enabled = true) {
  const { user } = useAuth()
  const { toast } = useToast()
  const { t } = useTranslation('messaging')
  const userId = user?.id
  const reading = useReplica(chatPins, userId && chatId && enabled ? [chatId] : null)
  useEffect(() => {
    if (!userId || !chatId || !enabled) return
    return watch(userId, chatId)
  }, [userId, chatId, enabled])
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
  return {
    // @@@reading-default - pins not read: no topic is drawn as pinned yet, and `ready` keeps the pin toggles off until they are
    topicIds: reading.state === 'value' ? reading.value.topicIds : NO_PINS,
    ready: reading.state === 'value', error: reading.state === 'error', saving: mutation.isPending,
    retry: () => { if (chatId) void chatPins.refresh(chatId) },
    set: (id: string, pinned: boolean) => mutation.mutate({ userId, chatId, id, pinned }),
  }
}
