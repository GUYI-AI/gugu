import { useEffect, useLayoutEffect } from 'react'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { useChatStore } from '@/store/chatContext'
import { useContactsStore } from '@/store/contactsContext'
import { useNativeAgentChats } from '@/hooks/useNativeAgentChats'
import { markChatListRestored, publishChatSummaries, publishContactSummaries, registerChatPin } from '@/lib/chatSummariesBridge'
import { clearChatRemovalFacts } from '@/lib/chatRemovalBridge'

/** One account writer in both shells, even when no desktop chat slot exists. */
export function ChatSummariesHost() {
  const { chats: imChats, chatsRead, loadingChats, chatsLoadFailed, identitiesById, pinChat } = useChatStore('chats', 'chatsRead', 'loadingChats', 'chatsLoadFailed', 'identitiesById', 'pinChat')
  const chats = useNativeAgentChats(imChats)
  const { contacts } = useContactsStore()
  useLayoutEffect(() => {
    if (chatsRead) publishChatSummaries(chats, chat => chatDisplayName(chat, identitiesById[chat.peer_user_id ?? '']?.display_name))
    if (chatsRead || loadingChats || chatsLoadFailed) markChatListRestored()
  }, [chats, chatsRead, loadingChats, chatsLoadFailed, identitiesById])
  useLayoutEffect(() => () => { clearChatRemovalFacts(); publishChatSummaries([]); publishContactSummaries([]) }, [])
  useEffect(() => { registerChatPin(pinChat); return () => registerChatPin(null) }, [pinChat])
  useEffect(() => { publishContactSummaries(contacts.map(contact => ({ id: contact.id, name: contact.alias || contact.display_name || contact.id }))) }, [contacts])
  return null
}
