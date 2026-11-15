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
export function safeDeliveredBody(body: string): string {
  if (!hasAttachmentDeliveryHints(body)) return body;
  return body.split('\n').filter(line => !ATTACHMENT_HINT.test(line)).join('\n').trimEnd();
}
