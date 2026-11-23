import { type ReactNode } from 'react';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels';
import { Avatar } from '../Avatar';
import { buildBubbleStyle } from './messageBubbleStyle';
import '../assistant/assistant-task-chat.css';

/**
 * Shared frame of read-only evidence (avatar, sender, time, bubble); no IM actions, write watermark or runtime
 * subscription. What the message says is the host's: a chat message brings the chat's own MessageBody.
 */
export function ReadOnlyMessageBubble({ message, mobile, sender, timestamp, children }: {
  message: MessageItem; mobile: boolean;
  sender: { display_name: string; avatar?: string | null; type?: string };
  timestamp?: ReactNode;
  children: ReactNode;
}) {
  // A task card is a surface of its own, ❌ wrapped in a second bubble (as in the chat).
  const card = message.content_type === 'card' && !!parseComposerCard(message.content);
  return <div data-task-exchange="true" data-message-id={message.id} data-mobile={mobile || undefined} data-own={message.is_mine || undefined} className="task-exchange">
    <Avatar seed={message.sender_user_id ?? undefined} name={sender.display_name} avatarUrl={sender.avatar} size="sm" isAgent={sender.type !== 'human'} still />
    <div className="task-exchange__column">
      <div data-message-sender-name="true" className="task-exchange__who">{sender.display_name}{timestamp}</div>
      <div className={card ? 'max-w-[100cqw]' : undefined} style={card ? undefined : buildBubbleStyle(message.is_mine, !!message.is_whisper, mobile)}>{children}</div>
    </div>
  </div>;
}

