/** @jsxImportSource solid-js */
/**
 * #2593 (owner 2026-11-13:「按理说应该有文本，但他这个气泡却没有文本」).
 *
 * A step that failed keeps a segment's process line out of the A2A fold (failures stay discoverable), while the send
 * that ends the segment still folds into「往来 N 条消息」(774475a753). The line left outside then had no bubble under it:
 * the agent's own last words were demoted to narration by the send. Under a line that stays outside, those words are
 * the bubble; the send stays in the fold.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { ChatItem, TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const peer = 'user:11111111-1111-4111-8111-111111111111';
const me = '22222222-2222-4222-8222-222222222222';
const delivery = (id: string): ChatItem => ({ kind: 'message', id, seq: 0, role: 'user', text:
  `<gugu_delivery route="chat" from="d3" from_id="${peer}" from_type="agent" chat="group" chat_kind="group" msg="msg:${id}"><![CDATA[Please open the PR]]></gugu_delivery>` });
const said: ChatItem = { kind: 'message', id: 'said', seq: 1, role: 'assistant', text: 'Committing and opening the PR now.' };
const command = (id: string, status: 'done' | 'error'): ChatItem => ({ kind: 'execute-tool-call', id, seq: 2, toolCallId: id, title: id, command: id, status });
const send: ChatItem = { kind: 'mcp-tool-call', id: 'send', seq: 3, toolCallId: 'send', title: 'Send', server: 'plugin_gugu-product_gugu', tool: 'message_send',
  status: 'done', rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [peer], text: 'Real reply content' }),
  outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' };
const turn = (id: string, items: ChatItem[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

async function mount(records: TranscriptTurn[]) {
  await page.viewport(800, 720);
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 },
    actor: id => id === peer ? { id, type: 'agent', name: 'd3' } : null,
    selfIdentity: () => ({ userId: me, displayName: 'Owner', guguNumber: null }), chatName: () => 'gugu', chatKind: () => 'group' });
  const state = createChatState(context);
  state.transcript.history.seed(records);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px';
  const view = createChatView({ context, state, parent: host });
  view.scrollToTop();
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  await until('activity row mounted', () => !!host.querySelector('[data-agent-activity]'));
  await untilStable('geometry settled', () => [host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height]);
  return host;
}
const heads = (host: HTMLElement) => host.querySelectorAll('[data-conversation-part="head"]');
const bodies = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-conversation-part="body"]')].map(el => el.textContent ?? '');

describe('a process line left outside the A2A fold keeps a bubble (#2593)', () => {
  it('shows the agent\'s own last words under the line a failed step keeps outside; the send stays folded', async () => {
    const host = await mount([turn('in', [delivery('incoming'), said, command('broken', 'error'), send])]);
    expect(heads(host)).toHaveLength(1);
    expect(bodies(host).some(text => text.includes('Committing and opening the PR now.'))).toBe(true);
    expect(host.innerHTML).not.toContain('Real reply content');
    // The incoming delivery above, the line and its words, then the send folded into its own row below them.
    const rows = [...host.querySelectorAll<HTMLElement>('[data-agent-activity]')];
    expect(rows.map(row => row.textContent)).toEqual(['Received 1 message from d3', 'Sent 1 message in gugu']);
    const words = [...host.querySelectorAll<HTMLElement>('[data-conversation-part="body"]')].find(el => el.textContent?.includes('Committing'))!;
    expect(words.getBoundingClientRect().bottom).toBeLessThanOrEqual(rows[1]!.getBoundingClientRect().top);
  });

  it('still folds the whole segment, words included, when nothing keeps it outside', async () => {
    const host = await mount([turn('in', [delivery('incoming'), said, command('fine', 'done'), send])]);
    expect(heads(host)).toHaveLength(0);
    expect(host.innerHTML).not.toContain('Committing and opening the PR now.');
    expect(host.innerHTML).not.toContain('Real reply content');
  });
});
