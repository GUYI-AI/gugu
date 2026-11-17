import { useCallback } from 'react'
import { createOptimisticDmChat } from '@gugu/core/shared/ui/chatModels'
import { chatService } from '../../lib/chat'
import { useAuth } from '../../store/auth'
import { useChatStore, useChatStoreReader } from '../../store/chatContext'
import { PERSON_ROW } from './forwardMessageUtils'

/**
 * Picked rows → chat ids, in order. A person (`person:<id>`) is their private chat: the one this account has, or one opened
 * now (open_dm, the way Contacts' 「发消息」 opens it; the server finds an existing one first). Every id is known before the
 * forward writes anything, so a chat that cannot be opened stops it whole.
 */
export function useResolveTargets() {
  const readChats = useChatStoreReader()
  const { upsertChat } = useChatStore('upsertChat')
  const { user } = useAuth()
  return useCallback(async (ids: readonly string[]): Promise<string[]> => {
    const resolved: string[] = []
    for (const id of ids) {
      if (!id.startsWith(PERSON_ROW)) { resolved.push(id); continue }
      const peer = id.slice(PERSON_ROW.length)
      const existing = readChats().chats.find((chat) => (chat.kind === 'dm' || chat.kind === 'ai') && chat.peer_user_id === peer)
      if (existing) { resolved.push(existing.id); continue }
      if (!user) throw new Error('Not signed in')
      const chatId = await chatService.getOrCreateDM(user.id, peer)
      upsertChat(createOptimisticDmChat(chatId, peer))
      resolved.push(chatId)
    }
    return resolved
  }, [readChats, upsertChat, user])
}
