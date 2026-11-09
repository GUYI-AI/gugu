import type { MessageItem } from '@gugu/core/shared/types/chat';
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels';
import { parseConversationLink, parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { serializeWidgetMessage } from '@gugu/core/shared/ui/widgetModels';
import type { TranscriptItem } from '../acp/models/turns/turn';
import { isGuguServer } from '../acp/models/turns/opened-outputs';
import { catalogCall } from '../acp/models/turns/tool-calls';
import { sentMessageId } from './reply-process';
import { sendReceipt } from './send-receipt';

type SentFields = Pick<MessageItem, 'id' | 'chat_id' | 'content' | 'content_type'>
  & Partial<Pick<MessageItem, 'file_item_id' | 'file_version' | 'file_blob_id' | 'session_file'>> & { at?: number };

/**
 * One message an agent said to people, in the chat's own message shape, so the task timeline draws it with the chat's
 * MessageBody. The sender is the agent the timeline belongs to (the host knows it); the rest of the row is what a
 * freshly delivered message of someone else looks like.
 */
export function sentChatMessage({ at, ...fields }: SentFields): MessageItem {
  return { sender_user_id: null, to_user_ids: null, seq: 0, reply_to_message_id: null, retracted_at: null,
    created_at: new Date(at ?? 0).toISOString(), is_mine: false, delivered: true, delivery_status: null, ...fields };
}

/**
 * The chat message an agent's successful send put into a chat, rebuilt from that call's arguments and receipt. It is
 * the message as it was sent: a later retraction or edit is not followed.
 *
 * A receipt from before the chat and file facts existed gives null, and the timeline keeps its older drawing for it.
 */
export function sentMessageOf(item: TranscriptItem): MessageItem | null {
  if (item.kind !== 'mcp-tool-call' || item.status !== 'done' || item.parentToolCallId || !isGuguServer(item.server)) return null;
  // A tool not in the agent's native list is called through catalog_call: the same send, its arguments one level in.
  const viaCatalog = catalogCall(item.tool, item.rawInput);
  const tool = /(?:^|__)(widget_send|message_send_file|message_send)$/.exec(viaCatalog?.tool ?? item.tool)?.[1];
  if (!tool) return null;
  const output = item.rawOutput || item.outputText;
  const receipt = sendReceipt(output);
  if (receipt?.delivery === 'owner-native') return null;
  let args: Record<string, unknown>;
  try { args = (viaCatalog ? viaCatalog.args : JSON.parse(item.rawInput ?? '')) as Record<string, unknown>; } catch { return null; }
  if (!args || typeof args !== 'object') return null;
  const linked = typeof receipt?.source_link === 'string' ? parseConversationLink(receipt.source_link)?.chatId : undefined;
  const at = item.completedAt ?? item.at;
  if (tool === 'message_send') {
    // Its receipt is the one-line `sent (id=…)`: the address the agent gave is the chat it named.
    const id = sentMessageId(item)?.replace(/^msg:/, '');
    const chatId = linked ?? (typeof args.chat_id === 'string' ? args.chat_id : null);
    return id && chatId && typeof args.text === 'string' && args.text.trim()
      ? sentChatMessage({ id, chat_id: chatId, content: args.text, content_type: 'text', at }) : null;
  }
  if (!receipt || typeof receipt.message_id !== 'string' || !linked) return null;
  const id = receipt.message_id.replace(/^msg:/, '');
  if (tool === 'widget_send') {
    const { app, view, text, height, data } = args;
    if (typeof app !== 'string' || typeof view !== 'string' || typeof text !== 'string') return null;
    const content = serializeWidgetMessage({ v: 2, text, app, view,
      ...(typeof height === 'number' ? { height } : {}), ...(data && typeof data === 'object' && !Array.isArray(data) ? { data: data as Record<string, unknown> } : {}) });
    return sentChatMessage({ id, chat_id: linked, content, content_type: 'widget', at });
  }
  const name = receipt.file_name, size = receipt.size_bytes, mime = receipt.mime_type;
  if (typeof name !== 'string' || typeof size !== 'number' || typeof mime !== 'string') return null;
  const pinned = typeof receipt.file === 'string' ? parseGroupFileLink(receipt.file) : null;
  return sentChatMessage({ id, chat_id: linked, content: attachmentEnvelope(name, size, mime), content_type: 'attachment', at,
    ...(pinned?.version !== undefined ? { file_item_id: pinned.itemId, file_version: pinned.version } : {}),
    ...(typeof receipt.file_blob_id === 'string' ? { file_blob_id: receipt.file_blob_id } : {}) });
}
