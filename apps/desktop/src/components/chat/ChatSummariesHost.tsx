import { useEffect, useLayoutEffect } from 'react'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { useChatStore } from '@/store/chatContext'
import { useContactsStore } from '@/store/contactsContext'
import { useNativeAgentChats } from '@/hooks/useNativeAgentChats'
import { markChatListRestored, publishChatSummaries, publishContactSummaries } from '@/lib/chatSummariesBridge'

/** One account writer in both shells, even when no desktop chat slot exists. */
export function ChatSummariesHost() {
  const { chats: imChats, chatsRead, loadingChats, chatsLoadFailed, identitiesById } = useChatStore('chats', 'chatsRead', 'loadingChats', 'chatsLoadFailed', 'identitiesById')
  const chats = useNativeAgentChats(imChats)
  const { contacts } = useContactsStore()
  useLayoutEffect(() => {
    if (chatsRead) publishChatSummaries(chats, chat => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name))
    if (chatsRead || loadingChats || chatsLoadFailed) markChatListRestored()
  }, [chats, chatsRead, loadingChats, chatsLoadFailed, identitiesById])
  useEffect(() => () => { publishChatSummaries([]); publishContactSummaries([]) }, [])
  useEffect(() => { publishContactSummaries(contacts.map(contact => ({ id: contact.id, name: contact.alias || contact.display_name || contact.id }))) }, [contacts])
  return null
}
