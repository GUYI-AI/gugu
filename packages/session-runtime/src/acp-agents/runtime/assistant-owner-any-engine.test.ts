/*
 * #566 「回复后让位给主人的新消息」:是不是个人助理由会话 meta(`guguAssistant.ownerId`)声明,与引擎无关。
 * Codex 助理的宿主也写这份声明;运行时 ❌ 再按 providerId 筛一遍。
 */
import { decodeSessionUpdate } from '@gugu/session-core/acp';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { isOk } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

const sourceId = 'f9e41e17-9630-4f24-a3ed-782616738ed0';
const delivery = (messageId: string) => renderDeliveryEnvelope({
  route: 'chat', from: 'Owner', fromId: 'user:owner', messageId: `msg:${messageId}`, chat: 'chat',
  chatKind: 'dm', at: '2026-11-10T04:10:00Z', content: 'hello',
});

describe('an assistant yields its replied turn to the owner on every engine', () => {
  it.each(['claude', 'codex'])('%s assistant: the owner’s next message interrupts the trailing turn', async (providerId) => {
    const h = makeAcpHarness({ providerId });
    h.agent.prompt.mockImplementationOnce(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);
    try {
      const input = makeStartInput({ sessionId: 'conv-a', providerId, sessionMeta: { guguAssistant: { ownerId: 'owner' } } });
      expect(isOk(await rt.startSession(input))).toBe(true);
      expect(isOk(rt.promptDetached('conv-a', { text: delivery(sourceId), origin: 'communication' }, { steerIfBusy: true }))).toBe(true);
      await h.agent.called('prompt');
      const event = (update: Record<string, unknown>) => h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate(update as SessionUpdate) });
      await event({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading.' } });
      await event({ sessionUpdate: 'tool_call', toolCallId: 'send', title: 'mcp__gugu__message_send', kind: 'other', status: 'in_progress',
        rawInput: { chat_id: 'chat', text: 'Done', reply_to_message_id: `msg:${sourceId}` } });
      await event({ sessionUpdate: 'tool_call_update', toolCallId: 'send', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'replied (id=msg:63369ee5-81b5-4f1f-89e9-9481095c84ed)' } }] });
      rt.promptDetached('conv-a', { text: delivery('40529fa8-8d6f-4b8f-9a42-f257a788fbdf'), origin: 'communication' }, { steerIfBusy: true });
      await vi.waitFor(() => expect(h.agent.cancel).toHaveBeenCalledTimes(1));
    } finally { await rt.dispose(); }
  });
});
