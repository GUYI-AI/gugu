import { hasAttachmentDeliveryHints, type ChatAttachment, type ChatState, type DeliveryMessagePresentation } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import { createEffect, createRoot } from 'solid-js';
import { parseSentAttachmentLink, sentAttachmentLink } from '@gugu/session-core/session-record/send-receipt';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { sentFileCopy } from '@/lib/sentFileCopies';
import { openImageViewer } from '@/lib/imageViewer';
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { originalSize } from '@/components/chat/originalSize';
import { keptDataUrl } from './kept-data-urls';

export function originalMessagePresentation(message: MessageItem): DeliveryMessagePresentation | null {
  if (message.content_type !== 'attachment' || message.retracted_at) return null;
  const attachment = parseAttachmentContent(message.content, message);
  if (!attachment) return null;
  // A picture opens in the viewer over the conversation it is drawn in (`openTranscriptImage`), by its folder version when it
  // has one; a file that is not a picture opens where its link says. The id names the message: its thumbnail is read again
  // when the message's file changes.
  const folder = attachment.source.kind === 'item' ? `gugu-file://${attachment.source.itemId}?v=${attachment.source.version}` : undefined;
  const href = attachment.kind === 'image' ? folder : folder ?? sentAttachmentLink(message.id, message.chat_id);
  const size = attachment.kind === 'image' ? originalSize(attachment) : undefined;
  return { text: attachment.caption ?? '', attachments: [{ id: sentAttachmentLink(message.id), name: attachment.fileName,
    kind: attachment.kind === 'image' ? 'image' : 'file', ...(href ? { href } : {}), ...(size ? { imageDimensions: size } : {}) }] };
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

/** The file a transcript row's link names: a message's file or a chat-folder version, read as the chat reads it. */
function deliveredSource(link: string | undefined): Extract<AttachmentSource, { kind: 'message' | 'item' }> | null {
  const messageId = link ? parseSentAttachmentLink(link)?.messageId : undefined;
  const file = messageId || !link ? null : parseGroupFileLink(link);
  return messageId ? { kind: 'message', messageId } : file?.version !== undefined ? { kind: 'item', itemId: file.itemId, version: file.version } : null;
}

/**
 * A picture on a transcript row opens in the shared viewer at once, as a chat message's picture does: out of the
 * thumbnail the row drew, its original read after with the viewer's loading. A message's file or a folder version opens
 * by its source; a task's own attachment by `read`, the read that drew its thumbnail. A repeated click while the viewer
 * is opening is the viewer's own to drop (@@@one-viewer).
 */
export function openTranscriptImage(attachment: Pick<ChatAttachment, 'id' | 'name' | 'href' | 'dataUrl' | 'imageDimensions'>, thumb: HTMLElement | undefined,
  read: (attachment: { id: string; name: string }) => Promise<string | null>): void {
  const picture = thumb?.tagName === 'IMG' ? thumb as HTMLImageElement : undefined;
  const source = deliveredSource(attachment.href) ?? deliveredSource(attachment.id);
  if (source) {
    void import('@/lib/attachmentBytes').then(({ openAttachmentImage }) => openAttachmentImage(source, attachment.name, undefined, { picture, size: attachment.imageDimensions }));
    return;
  }
  const preview = async () => {
    const url = await read(attachment);
    if (!url) throw new Error(translateSessionMessage('attachmentViewer.unavailable'));
    return url;
  };
  openImageViewer([{ url: attachment.dataUrl ?? '', ...(attachment.dataUrl ? {} : { preview }), alt: attachment.name, file: { name: attachment.name }, thumb }]);
}

async function readDeliveredAttachment(id: string): Promise<string | null> {
  const source = deliveredSource(id);
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

/**
 * The bubble's thumbnail read (`sessionThumb`), so a task draws what a chat draws: an expired file's kept preview, and a
 * picture whose bytes are still coming from its sender once they arrive (`nextAttachmentChange`), not a broken image.
 */
async function thumbOf(source: Parameters<typeof sentFileCopy>[0]): Promise<Blob | null> {
  const [{ sessionThumb }, { nextAttachmentChange }] = await Promise.all([import('@/lib/attachmentBytes'), import('@/lib/attachmentChanges')]);
  for (;;) {
    const bytes = await sessionThumb(source);
    if (bytes.status === 'ready') return bytes.blob;
    if (bytes.status === 'expired') return bytes.thumb ?? null;
    if (bytes.status !== 'pending' || source.kind !== 'message') return null;
    await nextAttachmentChange(source.messageId);
  }
}
