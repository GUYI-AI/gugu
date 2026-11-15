/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });
const peer = 'user:11111111-1111-4111-8111-111111111111';

it.each([390, 1024])('only moves content below the opened process by its new body height (%ipx)', async width => {
  await page.viewport(width, 820);
  const context = createChatContext({ locale: () => 'en-US',
    layout: { preset: 'double', userGutter: 0, agentConversation: true },
    actor: id => id === peer ? { id, name: 'Peer', type: 'agent' } : null,
    chatKind: () => 'group', chatName: () => 'Project' });
  const state = createChatState(context);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:720px`;
  const view = createChatView({ context, state, parent: host, pinUserMessages: false });
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  // Folded incoming activity followed by a process that must remain visible.
  // Keep this genuinely unconfirmed, so receipt parsing cannot mask the
  // independent height-index bug by collapsing the whole sequence as A2A.
  const history: TranscriptTurn[] = Array.from({ length: 5 }, (_, n) => ({
    id: `turn-${n}`, seq: n, initiator: 'agent', startedAt: n * 20000, endedAt: n * 20000 + 10000,
    outcome: { kind: 'done' }, items: [
      { kind: 'message', id: `input-${n}`, seq: 0, role: 'user', text:
        `<gugu_delivery route="chat" from="Peer" from_id="${peer}" from_type="agent" chat="group" chat_kind="group" msg="msg:input-${n}"><![CDATA[Report ${n}]]></gugu_delivery>` },
      { kind: 'mcp-tool-call', id: `send-${n}`, toolCallId: `send-${n}`, seq: 1, title: 'Send',
        tool: 'message_send', server: 'plugin_gugu-product_gugu', status: 'done',
        rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [peer], text: `Update ${n}` }),
        outputText: 'Delivery could not be confirmed.' },
      { kind: 'message', id: `silence-${n}`, seq: 2, role: 'assistant', text: '[NO_REPLY]' },
    ],
  }));
  state.transcript.history.seed(history);
  view.scrollToTop();
  const headers = () => [...host.querySelectorAll<HTMLElement>('[data-slot="turn-process"]')];
  const settle = () => untilStable('process and activity geometry settles', () =>
    [...host.querySelectorAll<HTMLElement>('[data-index]')].map(row => [row.dataset.index, row.style.top, row.style.height]));
  await until('all five process headers visible', () => headers().length === 5);
  await settle();
  const before = headers().map(row => ({ id: row.querySelector<HTMLElement>('[data-collapse-id]')!.dataset.collapseId!,
    top: row.getBoundingClientRect().top }));
  const clicked = before[1];
  host.querySelector<HTMLButtonElement>(`[data-collapse-id="${clicked.id}"]`)!.click();
  await until('expanded steps mounted', () => !!host.querySelector('[data-row-kind="conversation-process-steps"]'));
  await settle();
  const after = new Map(headers().map(row => [row.querySelector<HTMLElement>('[data-collapse-id]')!.dataset.collapseId!, row.getBoundingClientRect().top]));
  expect(after.size, 'opening one process must not replace other headers').toBe(before.length);
  const body = host.querySelector<HTMLElement>('[data-row-kind="conversation-process-steps"]')!.closest<HTMLElement>('[data-index]')!;
  const insertedHeight = body.getBoundingClientRect().height;
  expect(insertedHeight).toBeGreaterThan(0);
  for (const [index, row] of before.entries()) {
    expect(after.get(row.id)! - row.top, `${row.id}: unchanged above; one body-height shift below`).toBeCloseTo(index <= 1 ? 0 : insertedHeight, 0);
  }
  host.querySelector<HTMLButtonElement>(`[data-collapse-id="${clicked.id}"]`)!.click();
  await until('expanded steps removed', () => !host.querySelector('[data-row-kind="conversation-process-steps"]'));
  await settle();
  const restored = new Map(headers().map(row => [row.querySelector<HTMLElement>('[data-collapse-id]')!.dataset.collapseId!, row.getBoundingClientRect().top]));
  for (const row of before) expect(restored.get(row.id), `${row.id}: restored after closing`).toBeCloseTo(row.top, 0);
});
