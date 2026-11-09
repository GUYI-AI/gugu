/** @jsxImportSource solid-js */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until } from '../../../../tests/support/awaitCondition';

const chat = '127ec4f0-30b1-4583-b469-706756153bdd';
const id = '6417511d-8f36-4cbc-8cbb-81ce9f97df73';
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; });

const widget = (): TranscriptItem => ({ kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send', title: 'widget_send', tool: 'widget_send', server: 'gugu', status: 'done', at: 2000, completedAt: 3000,
  rawInput: JSON.stringify({ chat_id: chat, app: 'lens', view: 'card', text: 'Sales', height: 200 }),
  outputText: JSON.stringify({ status: 'sent', message_id: id, source_link: `gugu-chat://${chat}/${id}` }) });
const file = (): TranscriptItem => ({ kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send', title: 'message_send_file', tool: 'message_send_file', server: 'gugu', status: 'done', at: 2000, completedAt: 3000,
  rawInput: JSON.stringify({ file_path: '/work/sales.csv' }), // no address on the call: the bubble has no destination line
  outputText: JSON.stringify({ status: 'sent', message_id: id, source_link: `gugu-chat://${chat}/${id}`, file_name: 'sales.csv', size_bytes: 27, mime_type: 'text/csv' }) });
const words = (text: string): TranscriptItem => ({ kind: 'message', id: 'after', seq: 2, role: 'assistant', text });
const turn = (items: TranscriptItem[]): TranscriptTurn => ({ id: 'turn', seq: 0, initiator: 'user', startedAt: 1000, items });

function mount() {
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 0, agentConversation: true } });
  const state = createChatState(context), host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:900px;background:white';
  document.body.append(host);
  const taken = vi.fn(), offer = vi.fn((_target: { root: HTMLElement; message: { id: string } }) => taken);
  const view = createChatView({ context, state, parent: host, commands: { conversationAgentName: () => 'Agent', onMessageBodyMount: offer } });
  dispose = () => { view.dispose(); state.dispose(); context.dispose(); host.remove(); };
  const slot = () => host.querySelector<HTMLElement>(`[data-sent-message-body="${id}"]`);
  return { state, offer, taken, slot };
}

it('keeps one slot through a streaming turn, though the send is rebuilt as a new object on every pass', async () => {
  const { state, offer, taken, slot } = mount();
  state.transcript.activeTurn.set(turn([widget(), words('one')]));
  await until('the slot is offered', () => offer.mock.calls.length > 0);
  const root = slot();
  for (const text of ['one two', 'one two three', 'one two three four']) {
    state.transcript.activeTurn.set(turn([widget(), words(text)]));
    await new Promise(requestAnimationFrame);
  }
  await new Promise(requestAnimationFrame);
  expect(slot()).toBe(root);
  expect(offer).toHaveBeenCalledTimes(1);
  expect(taken).not.toHaveBeenCalled();
});

it('measures the slot by what the host reports, and a narrow first report cannot hold its content narrow', async () => {
  await page.viewport(1000, 900);
  const { state, offer, slot } = mount();
  state.transcript.history.seed([{ ...turn([widget()]), endedAt: 4000, outcome: { kind: 'done' as const } }]);
  await until('the slot is offered', () => offer.mock.calls.length > 0);
  await until('the estimate is the declared height', () => slot()?.style.height === '200px');
  const width = slot()!.style.width;
  expect(Number.parseFloat(width)).toBeGreaterThan(100);

  state.session.setBodySize(id, { width: 40, height: 123 });
  await until('the row takes the reported height', () => slot()?.style.height === '123px');
  // The slot stays the row's whole width: content inside can report wider again.
  expect(slot()!.style.width).toBe(width);
  const bubble = () => slot()!.closest<HTMLElement>('[data-user-card]')!.getBoundingClientRect().width;
  const narrow = bubble();
  state.session.setBodySize(id, { width: 240, height: 123 });
  await until('the bubble grows with a wider report', () => bubble() > narrow);
});

it('clips the slot to a bubble narrower than it, so a bubble with only a file in it has no sideways scrollbar', async () => {
  await page.viewport(1000, 900);
  const { state, offer, slot } = mount();
  state.transcript.history.seed([{ ...turn([file()]), endedAt: 4000, outcome: { kind: 'done' as const } }]);
  await until('the slot is offered', () => offer.mock.calls.length > 0);
  state.session.setBodySize(id, { width: 200, height: 60 });
  await until('the row takes the reported height', () => slot()?.style.height === '60px');
  const card = slot()!.closest<HTMLElement>('[data-user-card]')!;
  await until('the bubble hugs the report', () => card.getBoundingClientRect().width < slot()!.getBoundingClientRect().width);
  expect(card.scrollWidth).toBe(card.clientWidth);
});

it('takes the slot back when its message leaves, and offers another message its own', async () => {
  const { state, offer, taken, slot } = mount();
  state.transcript.activeTurn.set(turn([widget()]));
  await until('the slot is offered', () => offer.mock.calls.length > 0);
  state.transcript.activeTurn.set(turn([words('only words now')]));
  await until('the slot is gone', () => !slot());
  expect(taken).toHaveBeenCalledTimes(1);
});
