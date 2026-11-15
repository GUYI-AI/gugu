import type { ChatCommands } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels';
import { sentAttachmentLink } from '@gugu/session-core/session-record/send-receipt';

/** Open a sent file the way the timeline opens it: a chat file by its link, a session file through the session. */
export function openSentFile(meta: ParsedAttachment, message: MessageItem, commands: ChatCommands | undefined): void {
  if (meta.source.kind === 'session-file') {
    commands?.onViewAttachment?.({ attachment: { id: `path:${meta.source.path}`, name: meta.fileName, kind: meta.kind }, itemId: message.id, source: 'user-message' });
    return;
  }
  commands?.onOpenLink?.(meta.source.kind === 'item' ? `gugu-file://${meta.source.itemId}?v=${meta.source.version}` : sentAttachmentLink(message.id, message.chat_id || undefined));
}
