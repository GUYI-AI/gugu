import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from './chat'
import { replica } from './replica'

/** One message by id, read as the person reading (RLS): `null` when they cannot read it. A retraction: surfaces call `refresh(id)`. */
export const messageById = replica({
  name: 'messageById',
  scope: 'account',
  keep: 5 * 60_000,
  read: (accountId: string, messageId: string): Promise<MessageItem | null> => chatService.getMessageById(messageId, accountId),
})
