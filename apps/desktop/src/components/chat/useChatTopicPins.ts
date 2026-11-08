import { useMemo } from 'react'
import { useChatStoreReader, useChatStoreSelect } from '@/store/chatContext'
import { topicPinGroups } from './topicPinsModel'
import { useChatPinSettings } from './useChatPinSettings'

export function useChatTopicPins(chatId: string | null, enabled = true) {
  const pins = useChatPinSettings(chatId, enabled)
  // Only this chat's topics: a message elsewhere must not redraw the header that shows them.
  const readChats = useChatStoreReader()
  const topicsSignature = useChatStoreSelect((store) => chatId === null ? '' : JSON.stringify(store.chats.filter((chat) => chat.source_chat_id === chatId)))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is what the groups read from the list
  const groups = useMemo(() => topicPinGroups(readChats().chats, chatId, pins.topicIds), [topicsSignature, chatId, pins.topicIds])
  return {
    ...pins, ...groups,
    set: (topicId: string, pinned: boolean) => pins.set(topicId, pinned),
  }
}
