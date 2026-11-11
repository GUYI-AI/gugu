/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { createChatState } from '../state/chat-state';
import type { TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

// While the host's older-page request is running, the list shows three dots above its first row. They take no
// layout space, and a request that settles at once shows nothing.
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

const turn = (seq: number): TranscriptTurn => ({ id: `turn-${seq}`, seq, initiator: 'user', items: [
  { kind: 'message', id: `message-${seq}`, seq: 0, role: 'assistant', text: Array.from({ length: 6 }, (_, i) => `Line ${i} of reply ${seq}.`).join('\n\n') },
] });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => turn(from + i));
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)));

async function mount(request: () => Promise<TranscriptTurn[]>) {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:600px';
  document.body.append(host);
  let armed = false, asked = 0;
  const view = createChatView({ context, state, parent: host, onReachStart: () => {
    if (!armed || asked > 0) return;
    asked++;
    return request().then(page => { view.loadOlder(page); });
  } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.history.seed(range(1020, 1040));
  await until('the newest turn is rendered', () => host.querySelector('[data-item-id="message-1039"]') !== null);
  const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  await untilStable('settled at the tail', () => [scroller.scrollHeight, scroller.scrollTop]);
  armed = true;
  const toTop = async () => {
    for (let i = 0; i < 400 && scroller.scrollTop > 0; i++) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - 1500);
      scroller.dispatchEvent(new Event('scroll'));
      await frame();
    }
    expect(asked).toBe(1);
  };
  const dots = () => host.querySelector<HTMLElement>('[data-older-page-loading]');
  const firstRowTop = () => host.querySelector<HTMLElement>('[data-item-id="message-1020"]')!.getBoundingClientRect().top;
  return { scroller, toTop, dots, firstRowTop, turns: () => state.transcript.history.get().length };
}

it('shows three dots above the first row while an older page is on its way, without moving any row', async () => {
  const page = Promise.withResolvers<TranscriptTurn[]>();
  const view = await mount(() => page.promise);
  await view.toTop();
  const before = view.firstRowTop();
  await until('the dots are shown', () => view.dots() !== null);
  const dots = view.dots()!.getBoundingClientRect(), box = view.scroller.getBoundingClientRect();
  // The content column, not the scroller's own box: under classic scrollbars the box is a scrollbar wider than the
  // column, and its centre lies half a scrollbar to the right.
  const column = view.scroller.querySelector<HTMLElement>('[data-chat-canvas]')!.getBoundingClientRect();
  // In the padding above the first row, inside the viewport, centred on the content column.
  expect(dots.top).toBeGreaterThanOrEqual(box.top);
  expect(dots.bottom).toBeLessThanOrEqual(before);
  expect(Math.abs((dots.left + dots.right) / 2 - (column.left + column.right) / 2)).toBeLessThanOrEqual(1);
  expect(view.dots()!.getAttribute('role')).toBe('status');
  expect(view.dots()!.getAttribute('aria-label')).toBe('Loading earlier messages');
  expect(view.dots()!.children.length).toBe(3);
  // The lit dot lengthens only as far as the one before it shortens: the group keeps one width. Under reduced motion
  // the dots stand still at their resting width. Both are read each frame: another test file emulates reduced motion
  // on the page this one shares (agent-activity.contract), and it may be on for some of these frames.
  const widths = new Set<string>();
  for (let i = 0; i < 12; i++) {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    widths.add(`${still ? 'still' : 'flowing'}:${Math.round([...view.dots()!.children].reduce((sum, dot) => sum + dot.getBoundingClientRect().width, 0))}`);
    await frame();
  }
  expect([...widths].filter(one => one !== 'flowing:23' && one !== 'still:15')).toEqual([]);
  expect(view.firstRowTop()).toBe(before);
  page.resolve(range(1000, 1020));
  await until('the page is in history', () => view.turns() === 40);
  await until('the dots are gone', () => view.dots() === null);
});

it('shows nothing for a request that settles at once', async () => {
  const view = await mount(async () => range(1000, 1020));
  await view.toTop();
  await until('the page is in history', () => view.turns() === 40);
  expect(view.dots()).toBeNull();
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(view.dots()).toBeNull();
});

it('hides the dots when the request fails', async () => {
  const page = Promise.withResolvers<TranscriptTurn[]>();
  const view = await mount(() => page.promise);
  await view.toTop();
  await until('the dots are shown', () => view.dots() !== null);
  page.reject(new Error('host away'));
  await until('the dots are gone', () => view.dots() === null);
});
