import { useMemo, type ReactNode } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageSenderTarget } from '@gugu/session-chat-ui'
import { MessageSenderContext } from './MessageSenderContext'
import { useMobileShell } from '@/hooks/useMobileShell'

export function MessageSenderProvider({ message, group, children }: { message: Pick<MessageItem, 'id' | 'chat_id' | 'sender_user_id'>; group: boolean; children: ReactNode }) {
  const mobile = useMobileShell()
  const { id, chat_id: chatId, sender_user_id: senderId } = message
  // A fresh object per render would re-render every sender name under it whenever its row re-renders, past MessageBubble's memo.
  const target = useMemo((): MessageSenderTarget | null => group && mobile ? { kind: 'chat', chatId, messageId: id }
    : senderId ? { kind: 'sender', userId: senderId, ...(group ? { sourceChatId: chatId } : {}) } : null, [group, mobile, chatId, id, senderId])
  return <MessageSenderContext.Provider value={target}>{children}</MessageSenderContext.Provider>
}
