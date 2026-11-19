import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import type { ChatMessage } from '../model';

/** Display data read as the current person from the original IM message. Never provider input. */
export type DeliveryMessagePresentation = Pick<ChatMessage, 'text' | 'attachments'>;

/**
 * These reserved lines are added by the inbox attachment adapter (`attachmentLocationLines`), inside a delivery envelope
 * only. `File saved at local path:` and `File not saved:` are the wording of deliveries already stored in transcripts.
 */
const ATTACHMENT_HINT = /^\[(?:Folder file gugu-file:\/\/|Image attached(?: at local path)?:|File at local path:|Not on this computer\. To read or change it:|Deleted: there are no bytes to fetch|File saved at local path:|File not saved:)/;
export function hasAttachmentDeliveryHints(body: string): boolean {
  return body.split('\n').some(line => ATTACHMENT_HINT.test(line));
}
/**
 * What a delivery says to a person before its original message is read. An attachment message's own lines (`[附件] name`,
 * `[Size]`, `[Kind]`) are how the chat stores its file, not words: only its caption is shown; the file is drawn from the
 * original message (`DeliveryMessagePresentation`).
 */
export function safeDeliveredBody(body: string): string {
  if (!hasAttachmentDeliveryHints(body)) return body;
  const rest = body.split('\n').filter(line => !ATTACHMENT_HINT.test(line)).join('\n').trimEnd();
  const attachment = parseAttachmentContent(rest);
  return attachment ? attachment.caption ?? '' : rest;
}
