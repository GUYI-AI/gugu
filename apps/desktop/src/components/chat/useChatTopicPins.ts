import { useTranslation } from 'react-i18next'
import { useChatStore, useStoreValueBy } from '@/store/chatContext'
import { messageForUser } from '@/lib/userFacingError'
import { useToast } from '../toastContext'
import { topicsOfChat } from './innerSidebarTopicsModel'
import type { SourceTopic } from './topicPinsModel'

/**
 * A group's topics for the header's topic menu. Pinning is one thing everywhere (yangchichi msg:d6738d34): the topic
 * conversation's own `is_pinned`, the same flag and order the inner sidebar's topic rows use (pinned first, then by activity).
 */
export function useChatTopicPins(chatId: string | null) {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { pinChat } = useChatStore('pinChat')
  // Only this chat's topics: a message elsewhere must not redraw the header that shows them.
  const topics = useStoreValueBy(
    (store) => (chatId ? topicsOfChat(store.chats, chatId) as SourceTopic[] : []),
    (store) => [chatId, chatId && store.chats.filter((chat) => chat.source_chat_id === chatId)],
  )
  return {
    topics,
    pinned: topics.filter((topic) => topic.is_pinned),
    others: topics.filter((topic) => !topic.is_pinned),
    set: (topicId: string, pinned: boolean) => {
      void pinChat(topicId, pinned).catch((error: unknown) => {
        toast(t('chatArea.management.pinFailed', { reason: messageForUser(error) }), 'error')
      })
    },
  }
}
