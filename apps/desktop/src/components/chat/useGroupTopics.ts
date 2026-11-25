import { useStoreValueBy } from '@/store/chatContext'
import { topicsOfChat } from './innerSidebarTopicsModel'

/** The header's topic menu is ordered by activity. Only the sidebar orders by pin. */
export function useGroupTopics(chatId: string | null) {
  // Only this chat's topics: a message elsewhere must not redraw the header that shows them.
  return useStoreValueBy(
    (store) => (chatId ? topicsOfChat(store.chats, chatId, { pinnedFirst: false }) : []),
    (store) => [chatId, chatId && store.chats.filter((row) => row.source_chat_id === chatId)],
  )
}
