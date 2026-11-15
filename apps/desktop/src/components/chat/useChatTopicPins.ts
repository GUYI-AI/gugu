import { useMemo } from 'react'
import { useStoreValueBy } from '@/store/chatContext'
import { topicPinGroups } from './topicPinsModel'
import { useChatPinSettings } from './useChatPinSettings'

export function useChatTopicPins(chatId: string | null, enabled = true) {
  const pins = useChatPinSettings(chatId, enabled)
  // Only this chat's topics: a message elsewhere must not redraw the header that shows them.
  const chats = useStoreValueBy((store) => store.chats, (store) => [chatId, chatId && store.chats.filter((chat) => chat.source_chat_id === chatId)])
  const groups = useMemo(() => topicPinGroups(chats, chatId, pins.topicIds), [chats, chatId, pins.topicIds])
  return {
    ...pins, ...groups,
    set: (topicId: string, pinned: boolean) => pins.set(topicId, pinned),
  }
}
