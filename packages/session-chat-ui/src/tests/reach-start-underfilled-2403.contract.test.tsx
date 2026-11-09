/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { createChatState } from '../state/chat-state';
import type { TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

// #2403: a loaded page shorter than the viewport cannot scroll, so a reach-start that
// only re-arms on scroll fires once and the reader is stuck above blank space.
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

const turn = (seq: number): TranscriptTurn => ({ id: `turn-${seq}`, seq, initiator: 'user', items: [
  { kind: 'message', id: `message-${seq}`, seq: 0, role: 'assistant', text: `Short reply ${seq}` },
] });

async function mount(pages: number) {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:600px';
  document.body.append(host);
  let next = 1000, remaining = pages, calls = 0;
  // Each older page is a few short rows, like a page of folded agent exchanges.
  const view = createChatView({ context, state, parent: host, onReachStart: () => {
    calls++;
    if (remaining <= 0) return;
    remaining--;
    const page = [turn(next - 3), turn(next - 2), turn(next - 1)];
    next -= 3;
    queueMicrotask(() => view.loadOlder(page));
  } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.history.seed([turn(1000), turn(1001)]);
  await until('the newest page is rendered', () => host.querySelector('[data-item-id="message-1001"]') !== null);
  const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  await untilStable('older pages stop arriving', () => [calls, scroller.scrollHeight, scroller.scrollTop]);
  return { scroller, calls: () => calls, remaining: () => remaining };
}

it('keeps loading older pages while the loaded history does not fill the viewport', async () => {
  const { scroller, remaining } = await mount(40);
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  // Not the whole history: loading stops once a screen of history is above the reader.
  expect(remaining()).toBeGreaterThan(0);
  expect(scroller.scrollTop).toBeGreaterThanOrEqual(scroller.clientHeight);
});

it('stops asking once the host has no older history', async () => {
  const { calls, remaining } = await mount(2);
  expect(remaining()).toBe(0);
  const settled = calls();
  await untilStable('no further reach-start without new content', () => calls());
  expect(calls()).toBe(settled);
});
