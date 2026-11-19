import type { ComponentProps } from 'react'
import { useAuth } from '@/store/auth'
import { useActiveChatIdentity, useChatStore } from '@/store/chatContext'
import { HumanDmFriendshipNotice } from './HumanDmFriendshipNotice'
import { MessageList } from './MessageList'
export type { MessageListRowProps } from './MessageList'

/** Conversation-only footer composition; the generic list also serves tasks and split panes. */
export function ChatMessageList({ footer, ...props }: ComponentProps<typeof MessageList>) {
  const { user } = useAuth()
  const chat = useActiveChatIdentity()
  const { activeChatId, identitiesById, messageWindow } = useChatStore('activeChatId', 'identitiesById', 'messageWindow')
  const peer = identitiesById[chat?.peer_user_id ?? '']
  return <MessageList {...props} footer={<>
    {footer}
    {!messageWindow?.hasNewer && activeChatId && <HumanDmFriendshipNotice chatId={activeChatId} kind={chat?.kind} currentUserId={user?.id ?? null} peer={peer} />}
  </>} />
}
