/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { paintedFrames } from './painted-frames';

const long = 'A complete detail that the reader should be able to keep open.\n\n'.repeat(45);
const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const turn = (seq: number, text = 'Acknowledged.'): TranscriptTurn => ({ id: `stored-${seq}`, seq, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id: `input-${seq}`, seq: 0, role: 'user', text: 'A new question.' },
  { kind: 'message', id: `answer-${seq}`, seq: 1, role: 'assistant', text },
] });
function mount() {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1600px';
  document.body.append(host);
  let view = createChatView({ context, state, parent: host });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-user-card="${id}"]`);
  const settle = () => untilStable('message geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  const show = async (id: string) => {
    await settle();
    view.scrollToItem(id);
    await until(`the requested bubble ${id} mounts`, () => card(id) !== null);
    await settle();
  };
  return { host, state, card, settle, show, remount: () => { view.dispose(); view = createChatView({ context, state, parent: host }); } };
}

describe('persistent conversation message disclosure', () => {
  it.each(['user', 'assistant'] as const)('keeps the latest %s message fully visible until another message arrives', async role => {
    const v = mount();
    v.state.transcript.history.seed([{ id: 'latest', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'last', seq: 0, role, text: long },
    ] }]);
    await v.show('last');
    expect(v.card('last')!.offsetHeight).toBeGreaterThan(252);
    expect(v.host.querySelector('[data-expand-user-card="last"]')).toBeNull();
    v.state.transcript.history.append(Array.from({ length: 40 }, (_, index) => turn(index + 1)));
    await v.show('answer-40');
    expect(v.card('last')).toBeNull();
    await v.show('last');
    expect(v.card('last')!.offsetHeight).toBeLessThanOrEqual(252);
    expect(v.host.querySelector('[data-expand-user-card="last"]')).not.toBeNull();
  });

  it('does not fold the reply the reader is on when a message is sent under it; it folds once out of view', async () => {
    const v = mount();
    v.host.style.height = '800px';
    v.state.transcript.history.seed([...Array.from({ length: 4 }, (_, i) => turn(i)), turn(4, long)]);
    const scroller = v.host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    const gap = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    await until('the long reply is on screen at the tail', () => v.card('answer-4') !== null && gap() < 1);
    await v.settle();
    const view = () => scroller.getBoundingClientRect();
    expect(v.card('answer-4')!.getBoundingClientRect().top).toBeLessThan(view().top);
    // Every painted frame from the send on: the reply keeps its height, and what is drawn only moves up (the new
    // message enters below). A fold here swapped the lines the reader was on for the reply's head: a jump down.
    const card = () => { const element = v.card('answer-4'); return element ? { height: element.offsetHeight, top: element.getBoundingClientRect().top } : undefined; };
    const before = card()!;
    const painted = paintedFrames(card);
    const frames = painted.frames;
    v.state.transcript.activeTurn.set({ id: 'sent', seq: 5, initiator: 'user', items: [{ kind: 'message', id: 'input-5', seq: 0, role: 'user', text: 'Thanks.' }] });
    await until('the sent message renders', () => v.card('input-5') !== null);
    await v.settle();
    painted.stop();
    expect(gap()).toBeLessThan(1);
    expect(frames.map(frame => frame.height)).toEqual(frames.map(() => before.height));
    expect(frames.filter((frame, i) => frame.top > (i ? frames[i - 1]! : before).top + 0.5)).toEqual([]);
    // The answer pushes it out of view: it folds there, and the reader stays at the tail.
    v.state.transcript.activeTurn.set({ ...turn(5, long), id: 'sent', outcome: undefined });
    await until('the reply left the view', () => { const card = v.card('answer-4'); return !card || card.getBoundingClientRect().bottom <= view().top; });
    await v.settle();
    expect(gap()).toBeLessThan(1);
    await v.show('answer-4');
    expect(v.card('answer-4')!.offsetHeight).toBeLessThanOrEqual(252);
    expect(v.host.querySelector('[data-expand-user-card="answer-4"]')).not.toBeNull();
  });

  it('holds open only the bubble that last lost newest: the next long one to lose it folds the held one', async () => {
    const v = mount();
    v.host.style.height = '2400px';
    const medium = 'A reply long enough to fold, short enough that two fit on screen.\n\n'.repeat(12);
    v.state.transcript.history.seed([turn(0), turn(1, medium)]);
    await until('the first long reply is drawn', () => v.card('answer-1') !== null);
    await v.settle();
    const say = (items: TranscriptTurn['items']) => v.state.transcript.activeTurn.set({ id: 'live', seq: 2, initiator: 'user', items });
    const input2 = { kind: 'message', id: 'input-2', seq: 0, role: 'user', text: 'Thanks.' } as const;
    const answer2 = { kind: 'message', id: 'answer-2', seq: 1, role: 'assistant', text: medium } as const;
    say([input2]);
    await until('the send is drawn', () => v.card('input-2') !== null);
    await v.settle();
    expect(v.card('answer-1')!.offsetHeight).toBeGreaterThan(252);
    // A short bubble losing newest (the sent line, when the answer arrives) holds nothing and releases nothing.
    say([input2, answer2]);
    await until('the second long reply is drawn', () => v.card('answer-2') !== null);
    await v.settle();
    expect(v.card('answer-1')!.offsetHeight).toBeGreaterThan(252);
    say([input2, answer2, { kind: 'message', id: 'input-3', seq: 2, role: 'user', text: 'And one more.' }]);
    await until('the second send is drawn', () => v.card('input-3') !== null);
    await v.settle();
    expect(v.card('answer-1')!.offsetHeight).toBeLessThanOrEqual(252);
    expect(v.card('answer-2')!.offsetHeight).toBeGreaterThan(252);
  });

  it('keeps a manually expanded historical reply open across outside clicks, appends, scrolling and remount', async () => {
    const v = mount();
    v.state.transcript.history.seed([turn(0, long), turn(1)]);
    await v.show('answer-0');
    v.host.querySelector<HTMLButtonElement>('[data-expand-user-card="answer-0"]')!.click();
    await until('the reader opens the full reply', () => (v.card('answer-0')?.offsetHeight ?? 0) > 252);
    v.host.querySelector('[data-chat-canvas]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await v.settle();
    expect(v.card('answer-0')!.offsetHeight).toBeGreaterThan(252);
    v.state.transcript.history.append(Array.from({ length: 40 }, (_, index) => turn(index + 2)));
    await v.show('answer-41');
    expect(v.card('answer-0')).toBeNull();
    await v.show('answer-0');
    expect(v.card('answer-0')!.offsetHeight).toBeGreaterThan(252);
    v.remount();
    await v.show('answer-0');
    expect(v.card('answer-0')!.offsetHeight).toBeGreaterThan(252);
  });

  it('retains explicit expansion when a live row receives its durable stored identity', async () => {
    const v = mount();
    const live = 'fixture:turn:2', stored = 'fixture:turn:s2';
    const liveTurn: TranscriptTurn = { id: live, referenceId: stored, seq: 2, initiator: 'user', items: [
      { kind: 'message', id: `${live}:message:input`, seq: 0, role: 'user', text: long },
      { kind: 'message', id: `${live}:message:answer`, seq: 1, role: 'assistant', text: 'A short streamed answer.' },
    ] };
    v.state.transcript.activeTurn.set(liveTurn);
    await v.show(`${live}:message:input`);
    v.host.querySelector<HTMLButtonElement>(`[data-expand-user-card="${live}:message:input"]`)!.click();
    await until('the live input is open', () => (v.card(`${live}:message:input`)?.offsetHeight ?? 0) > 252);
    v.state.transcript.activeTurn.set(null);
    v.state.transcript.history.append([{ ...liveTurn, id: stored, outcome: { kind: 'done' }, items: liveTurn.items.map(item => ({ ...item, id: item.id.replace(live, stored) })) }]);
    await v.show(`${stored}:message:input`);
    expect(v.card(`${stored}:message:input`)!.offsetHeight).toBeGreaterThan(252);
    v.remount();
    await v.show(`${stored}:message:input`);
    expect(v.card(`${stored}:message:input`)!.offsetHeight).toBeGreaterThan(252);
  });

  it('keeps independent reader choices until each bubble is explicitly collapsed', async () => {
    const v = mount();
    v.state.transcript.history.seed([turn(0, long), turn(1, long), turn(2)]);
    for (const id of ['answer-0', 'answer-1']) {
      await v.show(id);
      v.host.querySelector<HTMLButtonElement>(`[data-expand-user-card="${id}"]`)!.click();
      await until('the selected reply opens', () => (v.card(id)?.offsetHeight ?? 0) > 252);
    }
    await v.show('answer-0');
    expect(v.card('answer-0')!.offsetHeight).toBeGreaterThan(252);
    v.host.querySelector<HTMLButtonElement>('[data-collapse-id^="conversation-bubble:"][data-collapse-anchor="answer-0"]')!.click();
    await until('only the selected reply collapses', () => (v.card('answer-0')?.offsetHeight ?? Infinity) <= 252);
    await v.show('answer-1');
    expect(v.card('answer-1')!.offsetHeight).toBeGreaterThan(252);
  });

  it('measures the latest streaming reply at its full height across a width change', async () => {
    const v = mount();
    v.state.transcript.activeTurn.set({ ...turn(0, long), outcome: undefined });
    await v.show('answer-0');
    expect(v.card('answer-0')!.offsetHeight).toBeGreaterThan(252);
    v.host.style.width = '600px';
    await v.settle();
    expect(v.card('answer-0')!.offsetHeight).toBeGreaterThan(252);
    const row = v.card('answer-0')!.closest<HTMLElement>('[data-item-id]')!;
    expect(row.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(v.card('answer-0')!.getBoundingClientRect().bottom - 1);
    expect(v.host.querySelector('[data-expand-user-card="answer-0"]')).toBeNull();
  });

  it('updates the reserved height when the formerly latest bubble becomes history offscreen', async () => {
    const v = mount();
    v.state.transcript.history.seed([...Array.from({ length: 30 }, (_, i) => turn(i)), turn(30, long)]);
    await v.show('answer-30');
    const canvas = () => v.host.querySelector<HTMLElement>('[data-chat-canvas]')!.getBoundingClientRect().height;
    await v.show('answer-0');
    expect(v.card('answer-30')).toBeNull();
    const fullHeight = canvas();
    v.state.transcript.history.append([turn(31)]);
    await v.settle();
    expect(canvas()).toBeLessThan(fullHeight);
  });

  it('treats batched deliveries as separate bubbles with independent expansion', async () => {
    const v = mount();
    const envelope = (message: string) => `<gugu_delivery route="chat" chat_kind="group" msg="msg:${message}" from="Peer"><![CDATA[${long}]]></gugu_delivery>`;
    const text = `<gugu_deliveries count="2">${envelope('11111111-1111-4111-8111-111111111111')}${envelope('22222222-2222-4222-8222-222222222222')}</gugu_deliveries>`;
    v.state.transcript.history.seed([{ id: 'batch-turn', seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: [
      { kind: 'message', id: 'batch', seq: 0, role: 'user', text },
    ] }]);
    await v.show('batch:batch-1');
    expect(v.card('batch:batch-0')!.offsetHeight).toBeLessThanOrEqual(252);
    expect(v.card('batch:batch-1')!.offsetHeight).toBeGreaterThan(252);
    v.host.querySelector<HTMLButtonElement>('[data-expand-user-card="batch:batch-0"]')!.click();
    await until('the first delivery opens independently', () => (v.card('batch:batch-0')?.offsetHeight ?? 0) > 252);
    v.state.transcript.history.append([turn(1)]);
    await v.settle();
    expect(v.card('batch:batch-0')!.offsetHeight).toBeGreaterThan(252);
    expect(v.card('batch:batch-1')!.offsetHeight).toBeLessThanOrEqual(252);
  });
});
