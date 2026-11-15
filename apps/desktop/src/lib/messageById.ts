import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from './chat'
import { replica } from './replica'

/**
 * One message by id, read as the person reading (RLS): `null` when they cannot read it (another chat, a whisper not to
 * them, deleted for them). Shared by every surface that shows a message it only knows by id (a link pill, a running
 * agent's prompt in its preview card). Kept five minutes after nothing shows it; a retraction is a `message_deleted`
 * revision, on which the surfaces showing it call `refresh(id)`.
 */
export const messageById = replica({
  name: 'messageById',
  scope: 'account',
  keep: 5 * 60_000,
  read: (accountId: string, messageId: string): Promise<MessageItem | null> => chatService.getMessageById(messageId, accountId),
})
