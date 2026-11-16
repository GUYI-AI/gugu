import { attachmentKind } from '@gugu/core/shared/ui/attachmentType';
import type { TranscriptItem } from '../acp/models/turns/turn';
import { isGuguServer } from '../acp/models/turns/opened-outputs';
import { sentMessageId } from './reply-process';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { sendReceipt, sentAttachmentLink } from './send-receipt';

/** Metadata from a confirmed send or an authorized IM row; never file bytes or a local path to open. */
export type SentAttachment = { messageId: string; name: string; href: string; caption?: string; kind?: 'image' | 'file' };

/** Only a successful root Gugu file send can become a visible attachment in the conversation. */
export function sentAttachmentOf(item: TranscriptItem): SentAttachment | null {
  // message_send with a file (message_send_file is the retired name, still in older transcripts).
  if (item.kind !== 'mcp-tool-call' || item.status !== 'done' || item.parentToolCallId || !isGuguServer(item.server)
    || !/(?:^|__)message_send(?:_file)?$/.test(item.tool)) return null;
  const id = sentMessageId(item)?.replace(/^msg:/, '');
  if (!id) return null;
  const output = sendReceipt(item.rawOutput || item.outputText);
  if (!output) return null;
  if (output.delivery === 'owner-native') return null;
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(item.rawInput ?? '{}') as Record<string, unknown>; } catch { /* receipt metadata is sufficient */ }
  if (/(?:^|__)message_send$/.test(item.tool) && !args.file && !args.file_path) return null;
  const name = typeof output?.file_name === 'string' ? output.file_name : typeof args?.file_name === 'string' ? args.file_name
    : typeof args?.file_path === 'string' ? args.file_path.split(/[\\/]/).at(-1) : undefined;
  if (!name?.trim()) return null;
  const chatId = typeof output.source_link === 'string' ? parseConversationLink(output.source_link)?.chatId : undefined;
  const mime = output.mime_type ?? output.mime ?? args.mime_type;
  const kind = attachmentKind({ fileName: name, mimeType: typeof mime === 'string' ? mime : '' });
  // Resolve the authorized message first: it supplies both the folder and the pinned file revision.
  return { messageId: id, name, kind, href: sentAttachmentLink(id, chatId), ...(typeof args?.text === 'string' && args.text.trim() ? { caption: args.text } : typeof args?.caption === 'string' && args.caption ? { caption: args.caption } : {}) };
}
