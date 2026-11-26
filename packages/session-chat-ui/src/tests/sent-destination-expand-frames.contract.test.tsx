/** @jsxImportSource solid-js */
/**
 * Owner 2026-11-26: opening「Sent 1 message in work」in a DM flashed the sent「Hi!」bubble twice its height, with its
 * 「Sent to work」line cut in half under the row's clip, for the length of the opening tween; then it snapped back.
 * The bubble followed the row's clip edge, and the row holds more than the bubble. Read in every painted frame.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { ChatItem, TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { paintedFrames } from './painted-frames';

const me = '22222222-2222-4222-8222-222222222222';
const ask: ChatItem = { kind: 'message', id: 'ask', seq: 0, role: 'user', text:
  `<gugu_delivery route="chat" from="Owner" from_id="user:${me}" from_type="human" chat="dm" chat_kind="dm" msg="msg:aaaaaaaa-1111-4111-8111-111111111111"><![CDATA[hi]]></gugu_delivery>` };
const send: ChatItem = { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send', title: 'Send', server: 'plugin_gugu-product_gugu', tool: 'message_send',
  status: 'done', rawInput: JSON.stringify({ chat_id: 'work', text: 'Hi!' }), outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' };
const reply: ChatItem = { kind: 'message', id: 'reply', seq: 2, role: 'assistant', text: 'Sent "Hi!" to the group.' };
const turn: TranscriptTurn = { id: 't', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [ask, send, reply] as TranscriptTurn['items'] };
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

describe('a sent message opened from its activity row', () => {
  it('never draws its bubble past its own height, nor its destination away from its text, while the row opens', async () => {
    await page.viewport(1200, 800);
    const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 },
      actor: () => null, selfIdentity: () => ({ userId: me, displayName: 'Owner', guguNumber: null }),
      chatName: (id?: string) => id === 'work' ? 'work' : 'hi', chatKind: (id?: string) => id === 'work' ? 'group' : 'dm' });
    const state = createChatState(context);
    state.transcript.history.seed([turn]);
    const host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = 'position:fixed;top:0;left:0;width:1200px;height:700px';
    const view = createChatView({ context, state, parent: host });
    cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
    await until('activity row', () => host.querySelector('[data-agent-activity]')?.textContent === 'Sent 1 message in work');
    await untilStable('settled', () => [host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height]);
    const card = () => [...host.querySelectorAll<HTMLElement>('[data-user-card]')].find(c => !!c.querySelector('[data-slot="sent-to"]'));
    const recording = paintedFrames(() => {
      const c = card();
      if (!c) return undefined;
      const text = c.querySelector('[data-conversation-text]')!.getBoundingClientRect(), to = c.querySelector('[data-slot="sent-to"]')!.getBoundingClientRect();
      return { card: Math.round(c.getBoundingClientRect().height), gap: Math.round(to.top - text.bottom) };
    });
    host.querySelector<HTMLButtonElement>('[data-agent-activity] [data-collapse-id]')!.click();
    await until('opened', () => !!card());
    await untilStable('open settled', () => [card()!.getBoundingClientRect().height, card()!.closest<HTMLElement>('[data-row-kind]')!.firstElementChild!.getAttribute('style')]);
    recording.stop();
    const rest = Math.round(card()!.getBoundingClientRect().height);
    expect(recording.frames.length, 'the opening tween is read frame by frame').toBeGreaterThan(5);
    expect(Math.max(...recording.frames.map(f => f.card)), 'the bubble never grows past its settled height').toBeLessThanOrEqual(rest);
    const restGap = recording.frames.at(-1)!.gap;
    expect(recording.frames.filter(f => f.gap > restGap), 'the destination stays right under the text in every frame').toEqual([]);
  });
});
