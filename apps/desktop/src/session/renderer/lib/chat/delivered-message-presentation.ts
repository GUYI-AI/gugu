import { hasAttachmentDeliveryHints, type ChatState, type DeliveryMessagePresentation } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import { createEffect, createRoot } from 'solid-js';
import { parseSentAttachmentLink, sentAttachmentLink } from '@gugu/session-core/session-record/send-receipt';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { sentFileCopy } from '@/lib/sentFileCopies';
import { keptDataUrl } from './kept-data-urls';

export function originalMessagePresentation(message: MessageItem): DeliveryMessagePresentation | null {
  if (message.content_type !== 'attachment' || message.retracted_at) return null;
  const attachment = parseAttachmentContent(message.content, message);
  if (!attachment) return null;
  // A picture opens from its message, over the conversation it is drawn in (openMessageAttachment → the image viewer), as
  // every message thumbnail does. A folder file's own link opens it in the chat that holds it, so only a file that is not a
  // picture keeps that link: it opens where it lives.
  const href = attachment.kind !== 'image' && attachment.source.kind === 'item' ? `gugu-file://${attachment.source.itemId}?v=${attachment.source.version}`
    : sentAttachmentLink(message.id, message.chat_id);
  return { text: attachment.caption ?? '', attachments: [{ id: `gugu-message-file://${message.id}`, name: attachment.fileName,
    kind: attachment.kind === 'image' ? 'image' : 'file', href }] };
}

/** The task page and both DM hosts resolve the same source ID with the current person's permissions. */
export function connectDeliveredMessagePresentation(state: ChatState, load: (id: string) => Promise<MessageItem | null>, onError: (id: string, error: unknown) => void): () => void {
  const requested = new Set<string>(), results = new Map(state.session.state.deliveredMessages);
  let live = true;
  const stop = createRoot(dispose => {
    createEffect(() => {
      const turns = [...state.transcript.history.get(), ...(state.transcript.state.activeTurnSnapshot ? [state.transcript.state.activeTurnSnapshot] : [])];
      // A delivery still waiting in its agent's queue is drawn too: it is read from then, not when its turn echoes it.
      const pending = [state.session.state.pendingPrompt, ...state.session.state.pendingMessages];
      const texts = [...turns.flatMap(turn => turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [item.text] : [])),
        ...pending.flatMap(input => input ? [input.text] : [])];
      for (const text of texts) {
        for (const segment of readDeliveryEnvelope(text)?.segments ?? []) {
          const id = segment.facts?.messageId?.replace(/^msg:/, '');
          // Plain text needs no extra read. Attachment transport hints are not a presentation.
          if (!id || requested.has(id) || !hasAttachmentDeliveryHints(segment.body)) continue;
          requested.add(id);
          void load(id).then(message => {
            if (!live || !message || message.id !== id) return;
            const presentation = originalMessagePresentation(message);
            if (presentation) { results.set(id, presentation); state.session.setDeliveredMessages(new Map(results)); }
          }).catch(error => { if (live) onError(id, error); });
        }
      }
    });
    return dispose;
  });
  return () => { live = false; stop(); };
}

// A message's file and a folder version never change: one read is kept for every row that draws it (`keptDataUrl`).
export function resolveDeliveredAttachment(id: string): Promise<string | null> {
  return keptDataUrl(id, () => readDeliveredAttachment(id));
}

async function readDeliveredAttachment(id: string): Promise<string | null> {
  const messageId = parseSentAttachmentLink(id)?.messageId;
  const file = messageId ? null : parseGroupFileLink(id);
  const source = messageId ? { kind: 'message' as const, messageId }
    : file?.version !== undefined ? { kind: 'item' as const, itemId: file.itemId, version: file.version } : null;
  if (!source) return null;
  // Sent from here: read on this device, even before the folder has it (`holdSentItem`).
  const blob = sentFileCopy(source) ?? await thumbOf(source);
  if (!blob) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function thumbOf(source: Parameters<typeof sentFileCopy>[0]): Promise<Blob | null> {
  const { attachmentBytes } = await import('@/lib/attachmentBytes');
  const result = await attachmentBytes(source, 'thumb');
  return result.status === 'ready' ? result.blob : null;
}
