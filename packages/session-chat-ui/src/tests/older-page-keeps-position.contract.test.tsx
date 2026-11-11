/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { createChatState } from '../state/chat-state';
import type { TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

// An older page landing above the reader must leave what they are reading where it is, with the page as new scroll
// room above. The three ways a host hands a page over (desktop `view.loadOlder`, phone `history.prepend`, a full
// `history.seed`) share one rebuild, so each case runs through all three.
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });

// Every turn is on one calendar day, as in a real session: the day line above the first loaded turn moves up to the
// older page's first turn when it lands, so the row at the very top of the list does not survive the rebuild.
// Local noon minus the 1000 minutes the turn numbers add: turns 960..1039 fall within 80 minutes of noon in any zone.
const DAY = new Date(2026, 10, 10, 12).getTime() - 1000 * 60_000;
const long = (seq: number) => Array.from({ length: 6 }, (_, i) => `Line ${i} of reply ${seq}.`).join('\n\n');
const turn = (seq: number): TranscriptTurn => ({
  id: `turn-${seq}`, seq, initiator: 'user', startedAt: DAY + seq * 60_000, endedAt: DAY + seq * 60_000 + 30_000, outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `message-${seq}`, seq: 0, role: 'assistant', text: long(seq) }],
});
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => turn(from + i));
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(null)));
const MODES = ['loadOlder', 'prepend', 'seed'] as const;
const PAGE = 20;

/** A transcript of turns 1020..1039 at its tail; each reach-start hands over the next older page after `delay` frames. */
async function mount(mode: (typeof MODES)[number], delay: number) {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:600px';
  document.body.append(host);
  let armed = false, inFlight = false, first = 1020, requested = 0;
  const view = createChatView({ context, state, parent: host, onReachStart: () => {
    if (!armed || inFlight) return;
    inFlight = true;
    requested++;
    const page = range(first - PAGE, first);
    first -= PAGE;
    void (async () => {
      for (let i = 0; i < delay; i++) await frame();
      if (mode === 'loadOlder') view.loadOlder(page);
      else if (mode === 'prepend') state.transcript.history.prepend(page);
      else state.transcript.history.seed([...page, ...state.transcript.history.get()]);
      inFlight = false;
    })();
  } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.history.seed(range(1020, 1040));
  await until('the newest turn is rendered', () => host.querySelector('[data-item-id="message-1039"]') !== null);
  const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  await untilStable('settled at the tail', () => [scroller.scrollHeight, scroller.scrollTop]);
  armed = true;
  const top = (id: string) => {
    const row = host.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
    return row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  };
  /** The first message with any part inside the viewport. */
  const reading = () => {
    const box = scroller.getBoundingClientRect();
    const row = [...host.querySelectorAll<HTMLElement>('[data-item-id^="message-"]')]
      .filter(el => el.getBoundingClientRect().bottom > box.top).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]!;
    return { id: row.dataset.itemId!, top: row.getBoundingClientRect().top - box.top };
  };
  const scrollBy = async (delta: number) => {
    scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
    scroller.dispatchEvent(new Event('scroll'));
    await frame();
  };
  /** Scroll up in steps until one more page has been asked for. */
  const scrollUpToNextRequest = async (step: number) => {
    const asked = requested;
    for (let i = 0; i < 400 && requested === asked; i++) await scrollBy(-step);
    expect(requested).toBe(asked + 1);
  };
  const settled = async (turns: number) => {
    await until('the older page is in history', () => state.transcript.history.get().length >= turns);
    await untilStable('layout settled', () => [scroller.scrollHeight, scroller.scrollTop, state.transcript.history.get().length]);
  };
  return { scroller, top, reading, scrollBy, scrollUpToNextRequest, settled, requested: () => requested, turns: () => state.transcript.history.get().length };
}

for (const mode of MODES) {
  it(`keeps the reading row when the page lands while the reader has stopped (${mode})`, async () => {
    const view = await mount(mode, 0);
    await view.scrollUpToNextRequest(150);
    const before = view.reading();
    await view.settled(40);
    expect(view.top(before.id)).toBeCloseTo(before.top, 0);
  });

  it(`keeps the reading row when the page lands while the reader is still scrolling (${mode})`, async () => {
    const view = await mount(mode, 3);
    await view.scrollUpToNextRequest(150);
    const before = view.reading();
    // 20 more frames of 10px each; the page lands on the third, in a frame that also carries the reader's own step.
    expect(view.scroller.scrollTop).toBeGreaterThan(200);
    for (let i = 0; i < 20; i++) await view.scrollBy(-10);
    await view.settled(40);
    expect(view.top(before.id)).toBeCloseTo(before.top + 200, 0);
  });

  it(`keeps the reading row and adds scroll room above when the reader is already at the very top (${mode})`, async () => {
    const view = await mount(mode, 12);
    // A fling: at the top within a few frames, long before the page arrives.
    for (let i = 0; i < 6; i++) await view.scrollBy(-1500);
    expect(view.scroller.scrollTop).toBe(0);
    const before = view.reading();
    await view.settled(40);
    // The page did load, above the reader: the same row at the same place, now a page of scroll room over it.
    expect(view.turns()).toBe(40);
    expect(view.top(before.id)).toBeCloseTo(before.top, 0);
    expect(view.scroller.scrollTop).toBeGreaterThan(view.scroller.clientHeight);
    // One trip to the top asks for one page; the rest of the history waits for the reader to scroll up again.
    expect(view.requested()).toBe(1);
    // Scrolling up again does ask for the next one.
    await view.scrollUpToNextRequest(600);
    await view.settled(60);
    expect(view.turns()).toBe(60);
  });
}
