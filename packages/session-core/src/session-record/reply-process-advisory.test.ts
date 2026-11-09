import { describe, expect, it } from 'vitest';
import type { McpToolCall } from '../acp/models/turns/tool-calls';
import { sentMessageId, successfulMessageSend } from './reply-process';
import { sendAddressesOf } from './send-addresses';

const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
// Native Claude tool_result shape from Beta 1222.1: one text block containing
// the successful receipt followed by the MCP server's send-frequency advisory.
const advisory = '\n提醒:你在这个群里 1 小时内已发 34 条,其间没有人发言。不急的话先停一下,等有人说话或 @ 你再继续。';
const call = (text: string, wrapped: boolean): McpToolCall => ({
  kind: 'mcp-tool-call', id: 'send', toolCallId: 'send', seq: 1, title: 'Send',
  server: 'plugin_gugu-product_gugu', tool: 'message_send', status: 'done',
  rawInput: JSON.stringify({ chat_id: 'group', reply_to_message_id: 'msg:source',
    to_user_ids: ['user:agent'], text: 'The next report is due at 23:00.' }),
  ...(wrapped ? { rawOutput: JSON.stringify({ content: [{ type: 'text', text }] }) } : { outputText: text }),
});

describe('message_send success with the server send-frequency advisory', () => {
  it.each(['sent', 'replied'].flatMap(verb => [false, true].map(wrapped => ({ verb, wrapped }))))(
    'keeps a $verb receipt confirmed (MCP wrapper=$wrapped)', ({ verb, wrapped }) => {
      const item = call(`${verb} (id=msg:${id})${advisory}`, wrapped);
      expect(sentMessageId(item)).toBe(id);
      expect(successfulMessageSend(item)).toMatchObject({ id, chat: 'group' });
      expect(sendAddressesOf(item)).toMatchObject({ recipients: ['user:agent'], confirmed: true });
    },
  );

  it('does not promote prose, embedded receipts or MCP errors to a confirmed send', () => {
    for (const text of [`The tool would reply: replied (id=msg:${id})`,
      `failed\nreplied (id=msg:${id})`, `replied (id=msg:${id}) but it failed`]) {
      expect(sentMessageId(call(text, false))).toBeNull();
    }
    expect(sentMessageId({ ...call('', false), rawOutput: JSON.stringify({ isError: true,
      content: [{ type: 'text', text: `replied (id=msg:${id})${advisory}` }] }) })).toBeNull();
  });
});
