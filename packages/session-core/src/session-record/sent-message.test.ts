import { describe, expect, it } from 'vitest';
import { parseAttachmentContent } from '@gugu/core/shared/ui/attachmentModels';
import { parseWidgetMessage } from '@gugu/core/shared/ui/widgetModels';
import { sentMessageOf } from './sent-message';
import type { McpToolCall } from '../acp/models/turns/tool-calls';

const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
const chat = '127ec4f0-30b1-4583-b469-706756153bdd';
const item = '2d8b0b6e-55f4-4a57-9d38-3c1c0b9a1f10';
const call = (tool: string, input: unknown, output: unknown): McpToolCall => ({ kind: 'mcp-tool-call', id: tool, toolCallId: tool, seq: 1,
  title: tool, tool, server: 'plugin_gugu-product_gugu', status: 'done', completedAt: Date.UTC(2026, 10, 8),
  rawInput: JSON.stringify(input), outputText: JSON.stringify(output) });
const widget = call('widget_send', { chat_id: 'user:owner', app: 'data-lens', view: 'card', text: 'Sales', height: 320, data: { file: 'gugu-file://x?v=1' } },
  { status: 'sent', message_id: id, source_link: `gugu-chat://${chat}/${id}` });
const file = call('message_send_file', { chat_id: chat, file_path: '/private/report.pdf' },
  { status: 'sent', message_id: id, file_name: 'report.pdf', size_bytes: 2048, mime_type: 'application/pdf', file: `gugu-file://${item}?v=3`, source_link: `gugu-chat://${chat}/${id}` });

describe('the chat message a send put into a chat', () => {
  it('rebuilds a widget from its arguments, in the chat the receipt names', () => {
    const message = sentMessageOf(widget)!;
    expect(message).toMatchObject({ id, chat_id: chat, sender_user_id: null, content_type: 'widget', is_mine: false, created_at: '2026-11-08T00:00:00.000Z' });
    expect(parseWidgetMessage(message.content)).toEqual({ v: 2, text: 'Sales', app: 'data-lens', view: 'card', height: 320, data: { file: 'gugu-file://x?v=1' } });
  });
  it('carries the widget identity the receipt names, as the message in the chat does', () => {
    const output = { ...(JSON.parse(widget.outputText!) as Record<string, unknown>), widget_id: 'stable-widget' };
    expect(parseWidgetMessage(sentMessageOf({ ...widget, outputText: JSON.stringify(output) })!.content)?.wid).toBe('stable-widget');
  });
  it('rebuilds a file card with the pinned folder revision', () => {
    const message = sentMessageOf(file)!;
    expect(message).toMatchObject({ id, chat_id: chat, content_type: 'attachment', file_item_id: item, file_version: 3 });
    expect(parseAttachmentContent(message.content, message)).toMatchObject({ fileName: 'report.pdf', sizeBytes: 2048, mimeType: 'application/pdf', kind: 'file', source: { kind: 'item', itemId: item, version: 3 } });
  });
  it('points an unpinned file at its message bytes', () => {
    const { file: _pinned, ...output } = JSON.parse(file.outputText!) as Record<string, unknown>;
    const message = sentMessageOf({ ...file, outputText: JSON.stringify({ ...output, file_blob_id: 'blob-1' }) })!;
    expect(parseAttachmentContent(message.content, message)?.source).toEqual({ kind: 'message', messageId: id });
  });
  it('reads a send made through catalog_call the same way', () => {
    const args = JSON.parse(widget.rawInput!) as Record<string, unknown>;
    const viaCatalog = { ...widget, tool: 'catalog_call', rawInput: JSON.stringify({ tool: 'widget_send', args }) };
    expect(sentMessageOf(viaCatalog)).toEqual(sentMessageOf(widget));
  });
  it('rebuilds a text send in the chat it named', () => {
    const text = call('message_send', { chat_id: chat, text: 'see [the chart](gugu-chat://x/y)' }, `sent (id=${id})`);
    expect(sentMessageOf({ ...text, outputText: `sent (id=${id})` })).toMatchObject({ id, chat_id: chat, content_type: 'text', content: 'see [the chart](gugu-chat://x/y)' });
  });
  it('keeps the older drawing for receipts without the chat or the file facts, and for anything not a confirmed root send', () => {
    expect(sentMessageOf({ ...widget, outputText: `sent (id=${id})` })).toBeNull();
    expect(sentMessageOf({ ...file, outputText: JSON.stringify({ status: 'sent', message_id: id, file_name: 'a', source_link: `gugu-chat://${chat}/${id}` }) })).toBeNull();
    expect(sentMessageOf({ ...file, outputText: JSON.stringify({ status: 'sent', message_id: id, delivery: 'owner-native' }) })).toBeNull();
    for (const changed of [{ status: 'running' }, { parentToolCallId: 'nested' }, { server: 'unrelated' }, { tool: 'session_message' }])
      expect(sentMessageOf({ ...widget, ...changed } as McpToolCall)).toBeNull();
  });
});
