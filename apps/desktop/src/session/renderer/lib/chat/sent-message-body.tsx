import { useLayoutEffect, useRef } from 'react';
import type { ChatCommands } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { openSentFile } from './sent-message-open';
import { MessageBody } from '@/components/chat/MessageBody';
import { SentMessageSurface } from '@/components/chat/sentMessageSurface';

/**
 * One message an agent sent to people, drawn in its task timeline by the chat's own MessageBody — the same widget, file
 * card and reference tags the chat shows. The timeline row only reserves the slot; this reports what it drew.
 */
export function SentMessageBody({ message, commands, onSize }: {
  message: MessageItem;
  commands: ChatCommands | undefined;
  onSize: (size: { width: number; height: number }) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const sizeTo = useRef(onSize);
  sizeTo.current = onSize;
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    // A hidden page (another tab, the app in the background) lays this out at 0×0: that is not its size, keep the last one.
    // The observer reports after layout and before paint, so reading its entry forces no layout of its own.
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.borderBoxSize[0];
      if (box && box.inlineSize > 0) sizeTo.current({ width: Math.ceil(box.inlineSize), height: Math.ceil(box.blockSize) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const sessionId = commands?.conversationAgentSession?.() ?? null;
  const shown: MessageItem = { ...message, sender_user_id: commands?.conversationAgentUserId?.() ?? null,
    ...(message.session_file ? { session_file: { ...message.session_file, session_id: sessionId } } : {}) };
  return <div ref={box} data-sent-message-body-content={message.id} style={{ width: 'fit-content', maxWidth: '100%', minWidth: 0 }}>
    <SentMessageSurface.Provider value><MessageBody message={shown} compact={false} isGroup={false} senderName={commands?.conversationAgentName?.() ?? ''}
      time={null} onOpenFile={meta => openSentFile(meta, message, commands)} onOpenWorkspaceFile={link => commands?.onOpenFile?.({ path: link.path, itemId: message.id, source: 'prose-link', ...(link.at ? { at: link.at } : {}) })} /></SentMessageSurface.Provider>
  </div>;
}
