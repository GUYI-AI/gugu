import { hasAttachmentDeliveryHints, type ChatState, type DeliveryMessagePresentation } from '@gugu/session-chat-ui';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import { createEffect, createRoot } from 'solid-js';
import { parseSentAttachmentLink } from '@gugu/session-core/session-record/send-receipt';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { sentFileCopy } from '@/lib/sentFileCopies';

export function originalMessagePresentation(message: MessageItem): DeliveryMessagePresentation | null {
  if (message.content_type !== 'attachment' || message.retracted_at) return null;
  const attachment = parseAttachmentContent(message.content, message);
  if (!attachment) return null;
  const href = attachment.source.kind === 'item' ? `gugu-file://${attachment.source.itemId}?v=${attachment.source.version}`
    : `gugu-message-file://${message.id}`;
  return { text: attachment.caption ?? '', attachments: [{ id: `gugu-message-file://${message.id}`, name: attachment.fileName,
    kind: attachment.kind === 'image' ? 'image' : 'file', href }] };
}

/** The task page and both DM hosts resolve the same source ID with the current person's permissions. */
export function connectDeliveredMessagePresentation(state: ChatState, load: (id: string) => Promise<MessageItem | null>, onError: (id: string, error: unknown) => void): () => void {
  const requested = new Set<string>(), results = new Map(state.session.state.deliveredMessages);
  // A committed turn never changes after it is placed (a changed one is a new object): its deliveries are read once.
  const read = new WeakSet<object>();
  let live = true;
  const stop = createRoot(dispose => {
    createEffect(() => {
      const fresh = state.transcript.history.get().filter(turn => !read.has(turn));
      for (const turn of fresh) read.add(turn);
      const active = state.transcript.state.activeTurnSnapshot;
      // A delivery still waiting in its agent's queue is drawn too: it is read from then, not when its turn echoes it.
      const pending = [state.session.state.pendingPrompt, ...state.session.state.pendingMessages];
      const texts = [...[...fresh, ...(active ? [active] : [])].flatMap(turn => turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [item.text] : [])),
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

// A message's file and a folder version never change: read once per run, so a row drawn again (its turn committing) has
// its picture in its first frame instead of reading it anew.
const deliveredReads = new Map<string, Promise<string | null>>();
export function resolveDeliveredAttachment(id: string): Promise<string | null> {
  const known = deliveredReads.get(id);
  if (known) return known;
  const read = readDeliveredAttachment(id).catch((error: unknown) => { deliveredReads.delete(id); throw error; });
  deliveredReads.set(id, read);
  void read.then(url => { if (!url) deliveredReads.delete(id); }, () => {});
  return read;
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
