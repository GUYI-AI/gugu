/** @jsxImportSource solid-js */
/**
 * @@@sticky-user-lanes (ChatRoot) — a user message stays at the top while its turn is on screen, as a
 * two-line summary, and the browser does the sticking.
 *
 * The failure this guards against was a frame lag: the stuck copy used to be placed from the
 * scroll event in rAF, while the compositor had already scrolled. Reading geometry right after a
 * scrollTop write, before any rAF, is that same frame: the summary must already be in place.
 */

import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { UNIT_REGISTRY } from '@session-chat/components/engine/unit-registry';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import { PIN_SUMMARY_GAP } from '@session-chat/layout-geometry';
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { ChatItem, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import type { SelfIdentity } from '@session-chat/lib/self-identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { pinnedSummaryShown } from '../../../../tests/support/pinnedSummaryShown';

/** Where a stuck summary's top sits, below the scroller's top edge. */
const PIN_LINE = UNIT_REGISTRY.message!.margin!.top!;

const teardown: Array<() => void> = [];
// Geometry and front-layer sweeps below exercise the ordinary reversible push-out.
// The host's accessibility preference must not silently select the other paint contract.
beforeEach(async () => {
  await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
});
afterEach(async () => {
  try { while (teardown.length) teardown.pop()?.(); }
  finally { await cdp().send('Emulation.setEmulatedMedia', { features: [] }); }
});

/** A user message and enough replies that its row leaves the virtualizer's overscan while they fill the screen. */
function exchange(id: string, seq: number, replies: number): ChatItem[] {
  const items: ChatItem[] = [{ kind: 'message', id: `${id}-user`, seq, role: 'user', text: `question ${id}` }];
  for (let i = 0; i < replies; i++) {
    items.push({ kind: 'message', id: `${id}-r${i}`, seq: seq + i + 1, role: 'assistant', text: `${id} reply ${i}. Lorem ipsum dolor sit amet.` });
  }
  return items;
}

/** A turn of one or more exchanges; several = messages inserted into the turn while it ran. */
function longTurn(id: string, seq: number, replies: number, inserted: string[] = []): TranscriptTurn {
  const items = [id, ...inserted].flatMap((x, k) => exchange(x, k * (replies + 1), replies));
  return { id, seq, initiator: 'user', items: items as TranscriptTurn['items'] };
}

async function mount(
  committed: TranscriptTurn[] = [longTurn('a', 0, 150), longTurn('b', 1, 150)],
  active?: TranscriptTurn,
  theme = DEFAULT_THEME,
  self?: SelfIdentity
) {
  // The host is 800 px wide; hit-testing a right-aligned card needs the whole host inside the viewport.
  await page.viewport(800, 600);
  const context = createChatContext({ locale: () => 'en-US', theme, ...(self ? { selfIdentity: () => self } : {}) });
  const state = createChatState(context);
  state.transcript.history.seed(committed);
  if (active) state.transcript.activeTurn.set(active, 'generating');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:320px;';
  document.body.appendChild(host);
  const view = createChatView({ context, state, parent: host, stickToBottom: false, pinUserMessages: true });
  teardown.push(() => {
    view.dispose();
    state.dispose();
    context.dispose();
    host.remove();
  });
  const scrollEl = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const edge = () => scrollEl.getBoundingClientRect().top;
  const card = (id: string) => host.querySelector<HTMLElement>(`[data-user-card="${id}"]`);
  /** The card's top below the scroller's top edge; null = not in the DOM. */
  const cardTop = (id: string) => {
    const el = card(id);
    return el ? el.getBoundingClientRect().top - edge() : null;
  };
  const summary = (id: string) => host.querySelector<HTMLElement>(`[data-pin-summary="${id}"]`);
  /** The summary's top below the scroller's top edge (PIN_LINE = stuck); null = not in the DOM. */
  const pinTop = (id: string) => {
    const el = summary(id);
    return el ? el.getBoundingClientRect().top - edge() : null;
  };
  /** The stuck summary's bottom; null while it is not on the pin line. */
  const pinBottom = (id: string) => Math.abs((pinTop(id) ?? -1) - PIN_LINE) < 1 ? summary(id)!.getBoundingClientRect().bottom : null;
  const mounted = (id: string) => host.querySelector(`[data-row-kind="message"][data-item-id="${id}"]`) != null;
  const scrollTo = async (st: number) => {
    scrollEl.scrollTop = st;
    await untilStable('transcript geometry settles', () => [scrollEl.scrollHeight, scrollEl.scrollTop]);
  };
  await until('transcript mounted', () => mounted('a-user'));
  await scrollTo(0);
  return { host, scrollEl, card, cardTop, summary, pinTop, pinBottom, mounted, scrollTo, view };
}

describe('sticky user lanes', () => {
  it.each(['no-preference', 'reduce'] as const)('honors %s while a pinned summary leaves and returns', async motion => {
    await cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: motion }] });
    expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(motion === 'reduce');
    const t = await mount([longTurn('a', 0, 4), longTurn('b', 1, 20)]);
    const lane = t.card('a-user')!.closest<HTMLElement>('[data-index]')!;
    const summary = t.summary('a-user')!;
    const laneEnd = t.scrollEl.scrollTop + lane.getBoundingClientRect().bottom - t.scrollEl.getBoundingClientRect().top;
    const leavingAt = laneEnd - summary.getBoundingClientRect().height - PIN_SUMMARY_GAP - PIN_LINE;
    await t.scrollTo(leavingAt - 8);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 1);
    expect(lane.dataset.pinLeaving).toBe('false');
    expect(pinnedSummaryShown(summary), 'both modes keep a fully stuck summary readable').toBe(true);
    await t.scrollTo(leavingAt + 5);
    expect(t.pinTop('a-user'), 'the browser still computes the same partial push-out').toBeCloseTo(PIN_LINE - 5, 1);
    expect(lane.dataset.pinLeaving).toBe('true');
    expect(getComputedStyle(summary).visibility).toBe(motion === 'reduce' ? 'hidden' : 'visible');
    expect(pinnedSummaryShown(summary), 'reduced motion hides at push-out; ordinary motion stays in front').toBe(motion !== 'reduce');
    await t.scrollTo(leavingAt - 8);
    expect(lane.dataset.pinLeaving).toBe('false');
    expect(pinnedSummaryShown(summary), 'scrolling back restores the summary in both modes').toBe(true);
  });

  it('preserves the attachment-name summary when a pure attachment row has no text bubble', async () => {
    const committed = longTurn('a', 0, 1);
    committed.items = [{ kind: 'message', id: 'a-user', seq: 0, role: 'user', text: '',
      attachments: [{ id: 'file', name: 'report.pdf', kind: 'file' }] },
      { kind: 'message', id: 'a-r0', seq: 1, role: 'assistant', text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. Lorem ipsum dolor sit amet.`).join('\n\n') },
    ] as TranscriptTurn['items'];
    const t = await mount([committed], undefined, buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true }));
    await until('attachment summary mounted', () => t.summary('a-user'), summary => summary != null);
    expect(t.card('a-user')).toBeNull();
    expect(t.summary('a-user')!.hasAttribute('data-pin-bare')).toBe(true);
    expect(t.summary('a-user')!.textContent).toBe('report.pdf');
    await t.scrollTo(900);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 0);
  });

  it('keeps active and committed answer rows out of pin lanes while ordinary user text still sticks', async () => {
    const answered = (id: string): ChatItem => ({ kind: 'message', id, seq: 1, role: 'user',
      text: '<gugu_question_answer>\n' + JSON.stringify({ question_id: id, state: 'answered', answers: [{ selected: ['Keep it'] }] })
        + '\n</gugu_question_answer>' });
    const committed = longTurn('a', 0, 1);
    committed.items = [committed.items[0], answered('answer-done'),
      { kind: 'message', id: 'a-r0', seq: 2, role: 'assistant', text: Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. Lorem ipsum dolor sit amet.`).join('\n\n') },
    ] as TranscriptTurn['items'];
    const active = { id: 'active', seq: 1, initiator: 'user', items: [answered('answer-live'),
      { kind: 'message', id: 'active-reply', seq: 2, role: 'assistant', text: 'Reply after the answer.' }] } as TranscriptTurn;
    const t = await mount([committed], active, buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true }));
    await until('long committed reply can expand', () => t.host.querySelector<HTMLButtonElement>('[data-expand-user-card]'), button => button != null);
    t.host.querySelector<HTMLButtonElement>('[data-expand-user-card]')!.click();
    await untilStable('expanded reply measured', () => t.scrollEl.scrollHeight);
    for (const id of ['answer-done', 'answer-live']) {
      await t.view.scrollToItem(id, { align: 'center' });
      await until(`${id} visible`, () => t.host.querySelector(`[data-item-id="${id}"] [data-slot="question-answer"]`), row => row != null);
      expect(t.summary(id), `${id} is a status line, not a sticky text bubble`).toBeNull();
      expect(t.card(id)).toBeNull();
      expect(t.host.textContent).not.toContain('<gugu_question_answer>');
    }
    t.view.scrollToTop();
    await untilStable('owner position restored after answer navigation', () => [t.scrollEl.scrollTop, t.scrollEl.scrollHeight]);
    await until('ordinary user summary exists', () => t.summary('a-user'), summary => summary != null);
    await t.scrollTo(900);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 0);
  });

  it('never shows the lines its summary repeats, in the same frame as any scroll write', async () => {
    const t = await mount();
    const lane = t.card('a-user')!.closest<HTMLElement>('[data-index]')!;
    const edge = () => t.scrollEl.getBoundingClientRect().top;
    const shown = () => pinnedSummaryShown(t.summary('a-user')!);
    const cover = () => t.summary('a-user')!.getBoundingClientRect();
    expect(shown(), 'the message is on screen').toBe(false);
    const handOver = Math.round(t.scrollEl.scrollTop + t.cardTop('a-user')!);
    await t.scrollTo(handOver + 150);
    expect(shown(), 'stuck before the sweep').toBe(true);
    const repeats = t.summary('a-user')!.getBoundingClientRect().height;
    // Sweep back over the hand-over and forth, reading right after each write: no frame runs in between, so the
    // drawn-or-not flag is a frame late, as it is under load. Wherever the lines it repeats are on screen below the
    // pin line while the summary is drawn, the summary's bubble is over them.
    const down = Array.from({ length: 91 }, (_, i) => handOver - 120 + 3 * i);
    let covered = 0;
    for (const st of [...[...down].reverse(), ...down]) {
      t.scrollEl.scrollTop = st;
      if (!shown()) continue;
      const card = t.card('a-user')!.getBoundingClientRect();
      const top = Math.max(card.top, edge() + PIN_LINE), bottom = card.top + repeats;
      if (bottom <= top) continue;
      covered++;
      expect(cover().top, `scrollTop=${st}`).toBeLessThanOrEqual(top + 0.5);
      expect(cover().bottom, `scrollTop=${st}`).toBeGreaterThanOrEqual(bottom - 0.5);
    }
    expect(covered, 'the sweep met frames with both on screen').toBeGreaterThan(0);
    await t.scrollTo(handOver - 60);
    expect(shown(), 'resting, the summary is not drawn').toBe(false);
    await t.scrollTo(900);
    expect(shown()).toBe(true);
    // Owner 2026-11-22: stuck, only the bubble is drawn — no page-colored strip around it, and beside it clicks reach the rows.
    const layer = lane.firstElementChild as HTMLElement;
    expect(layer.children.length, 'nothing but the summary in the stuck layer').toBe(1);
    expect(getComputedStyle(layer).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(layer.contains(document.elementFromPoint(cover().left - 20, cover().top + cover().height / 2)), 'a click beside the bubble').toBe(false);
    expect(layer.contains(document.elementFromPoint(cover().left + 20, cover().top + cover().height / 2)), 'a click on the bubble').toBe(true);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 0);
    expect(t.cardTop('a-user')!, 'the message itself scrolled away').toBeLessThan(0);
  });
  it('places the summary by one function of the scroll position, whatever the message\'s height and the scroll path', async () => {
    // One line and two (the summary is the bubble), five (cut to two but not folded), six (folded), then unfolded.
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
    const turn = (id: string, seq: number, text: string): TranscriptTurn => ({ id, seq, initiator: 'user', items: [
      { kind: 'message', id: `${id}-user`, seq: 0, role: 'user', text },
      { kind: 'message', id: `${id}-final`, seq: 1, role: 'assistant',
        text: Array.from({ length: 12 }, (_, i) => `${id} reply ${i}. Lorem ipsum dolor sit amet.`).join('\n\n') },
    ] as TranscriptTurn['items'] });
    const ids = ['a', 'b', 'c', 'd'];
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
    const t = await mount([...[1, 2, 5, 6].map((n, i) => turn(ids[i]!, i, lines(n))), longTurn('z', 4, 150)], undefined, theme);
    const edge = () => t.scrollEl.getBoundingClientRect().top;
    const frames = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const scrollAndSettle = async (st: number) => {
      let dispatched = false;
      const onScroll = () => { dispatched = true; };
      t.scrollEl.addEventListener('scroll', onScroll);
      try {
        const before = t.scrollEl.scrollTop;
        t.scrollEl.scrollTop = st;
        // The pin paint scheduler is armed by scroll, not by the test's rAFs.
        if (t.scrollEl.scrollTop !== before) await until('jump scroll event dispatched', () => dispatched);
        await frames();
      } finally { t.scrollEl.removeEventListener('scroll', onScroll); }
    };
    const sweep = async (id: string) => {
      await t.view.scrollToItem(`${id}-user`);
      await until(`${id} on screen`, () => t.card(`${id}-user`), el => el != null);
      await untilStable(`${id} settled`, () => t.cardTop(`${id}-user`));
      const lane = t.card(`${id}-user`)!.closest<HTMLElement>('[data-index]')!, summary = t.summary(`${id}-user`)!;
      const h = summary.getBoundingClientRect().height;
      const from = Math.round(t.scrollEl.scrollTop + t.cardTop(`${id}-user`)! - 40);
      const to = Math.round(t.scrollEl.scrollTop + lane.getBoundingClientRect().bottom - edge() + 20);
      const read = (st: number) => {
        const card = t.card(`${id}-user`)!.getBoundingClientRect(), pin = summary.getBoundingClientRect();
        const b = card.bottom - edge(), e = lane.getBoundingClientRect().bottom - edge();
        // T = min(max(P, b - h), e - h - gap), read from the layout alone.
        expect(pin.top - edge(), `${id} scrollTop=${st}: where the summary is`).toBeCloseTo(Math.min(Math.max(PIN_LINE, b - h), e - h - PIN_SUMMARY_GAP), 1);
        expect([pin.left, pin.right], `${id} scrollTop=${st}: as wide as the bubble`).toEqual([card.left, card.right]);
        // Whatever is left of the message below the pin line lies inside the summary's box: nothing shows beside it.
        expect(card.bottom, `${id} scrollTop=${st}: the summary reaches the bubble's end`).toBeLessThanOrEqual(pin.bottom + 0.01);
        const pushed = e - h - PIN_SUMMARY_GAP < Math.max(PIN_LINE, b - h);
        return { top: pin.top - edge(), stuck: PIN_LINE > b - h + 0.5, shown: pinnedSummaryShown(summary),
          regime: pushed ? 'pushed' : PIN_LINE > b - h ? 'stuck' : 'below' };
      };
      const seen = new Map<number, number>(), regime = new Map<number, string>();
      const down = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      // Every pixel down and back with no frame in between, then jumps in an order no drag makes, a frame each.
      // The jumps are the part paced by frames (two per jump), so they go where the placement can break: both pixels
      // of every regime change (below the pin line, stuck, pushed off) and the middle of every regime.
      for (const st of [...down, ...[...down].reverse()]) {
        t.scrollEl.scrollTop = st;
        const now = read(st);
        expect(seen.get(st) ?? now.top, `${id} scrollTop=${st}: the same place both ways`).toBe(now.top);
        seen.set(st, now.top);
        regime.set(st, now.regime);
      }
      const jumps = new Set<number>();
      for (let i = 1, start = 0; i <= down.length; i++) {
        if (i < down.length && regime.get(down[i]!) === regime.get(down[i - 1]!)) continue;
        jumps.add(down[Math.floor((start + i - 1) / 2)]!);
        if (i < down.length) { jumps.add(down[i - 1]!); jumps.add(down[i]!); }
        start = i;
      }
      expect(new Set(regime.values()), `${id}: the sweep meets every regime`).toEqual(new Set(['below', 'stuck', 'pushed']));
      for (const st of [...jumps].sort((x, y) => (x * 7919) % 101 - (y * 7919) % 101)) {
        await scrollAndSettle(st);
        const now = read(st);
        expect(now.top, `${id} scrollTop=${st}: the same place after a jump`).toBe(seen.get(st));
        // Pushed above the scroller, there is nothing left to hit.
        if (now.top >= 0) {
          let detail = '';
          if (now.shown !== now.stuck) {
            const pin = summary.getBoundingClientRect(), card = t.card(`${id}-user`)!.getBoundingClientRect();
            const hit = document.elementFromPoint(pin.left + pin.width / 2, Math.max(edge() + 1, pin.top + 1));
            detail = JSON.stringify({ scrollTop: t.scrollEl.scrollTop, sampledHeight: h, connected: summary.isConnected,
              pin: pin.toJSON(), card: card.toJSON(), lane: lane.getBoundingClientRect().toJSON(),
              stuckAttribute: lane.dataset.pinStuck, leavingAttribute: lane.dataset.pinLeaving,
              layerHeight: lane.style.getPropertyValue('--pin-layer-h'), hit: hit?.outerHTML.slice(0, 700) });
          }
          expect(now.shown, `${id} scrollTop=${st}: in front exactly while stuck ${detail}`).toBe(now.stuck);
        }
      }
    };
    for (const id of ids) await sweep(id);
    t.card('d-user')!.click();
    await until('d unfolded', () => t.card('d-user')!.getBoundingClientRect().height, height => height > 150);
    await sweep('d');
  });

  it('sticks the user row in the same frame as the scroll, deep inside a long turn', async () => {
    const t = await mount();
    for (const st of [200, 900, 1700, 2600]) {
      t.scrollEl.scrollTop = st;
      // Same frame: no rAF has run since the write.
      expect(t.scrollEl.scrollTop, 'the driver moved the scroller').toBe(st);
      expect(t.pinTop('a-user'), `stuck at scrollTop=${st}`).toBeCloseTo(PIN_LINE, 0);
    }
  });

  it('keeps the stuck row mounted after the virtualizer recycles its neighbours', async () => {
    const t = await mount();
    await t.scrollTo(2600);
    // Precondition: the turn's first replies are recycled, so the user row is far outside the range.
    expect(t.mounted('a-r0'), 'the first reply of the turn was recycled').toBe(false);
    expect(t.mounted('a-r149'), 'still inside turn a').toBe(false);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 0);
    expect(t.host.querySelectorAll('[data-pin-summary="a-user"]')).toHaveLength(1);
  });

  it('lands a jump into a far lane below its summary, whether or not the lane was on screen', async () => {
    const t = await mount();
    await t.scrollTo(t.scrollEl.scrollHeight);
    // Precondition: the target's lane is far off screen, so its summary geometry is laid out on demand.
    expect(t.mounted('a-user'), 'lane a is not mounted at the bottom').toBe(false);
    const rowTop = () => t.host.querySelector('[data-item-id="a-r60"]')!.getBoundingClientRect().top;
    const land = async () => {
      t.view.scrollToItem('a-r60', { align: 'start' });
      // The first write already lands: the lane's geometry is right before the lane is mounted.
      const first = t.scrollEl.scrollTop;
      await until('a-r60 on screen', () => t.mounted('a-r60'));
      await untilStable('a-r60 settled', () => [t.scrollEl.scrollTop, rowTop()]);
      expect(t.scrollEl.scrollTop, 'no correction after the first write').toBe(first);
      return rowTop() - t.pinBottom('a-user')!;
    };
    const far = await land();
    expect(far, 'the reply starts below its stuck summary').toBeCloseTo(PIN_SUMMARY_GAP, 0);
    await t.scrollTo(t.scrollEl.scrollTop + 400);
    expect(await land(), 'the same place as a jump from inside the lane').toBeCloseTo(far, 1);
  });

  it('is pushed off by the next user message, which then sticks inside its own turn', async () => {
    const t = await mount();
    // Walk down until b's row is on screen below the stuck a.
    let st = 2600;
    while (!(t.cardTop('b-user') !== null && t.cardTop('b-user')! < 250 && t.cardTop('b-user')! > 120)) {
      st += 100;
      expect(st, 'b-user came into view').toBeLessThan(20_000);
      await t.scrollTo(st);
    }
    // Through the handoff, frame by frame: a's summary is stuck or pushed up by b, the two never overlap.
    for (let i = 0; i < 40; i++) {
      t.scrollEl.scrollTop = st + i * 6;
      const a = t.pinBottom('a-user');
      if (a !== null) expect(a, `step ${i}`).toBeLessThanOrEqual(t.card('b-user')!.getBoundingClientRect().top + 1);
    }
    await t.scrollTo(st + 1500);
    expect(t.pinTop('b-user'), 'b is the stuck one inside its own turn').toBeCloseTo(PIN_LINE, 0);
    const aTop = t.pinTop('a-user');
    expect(aTop === null || aTop < 0, 'a left with its turn').toBe(true);
  });

  it('a long delivered insertion in the same turn scrolls clear of the preceding pinned bubble', async () => {
    const first = longTurn('a', 0, 1);
    const text = '输入框遮挡 · 过程行展开 · 原消息引用回跳。请保留真实截图。\n\n'.repeat(30);
    first.items.splice(1, 0, {
      kind: 'message', id: 'inserted', seq: 1, role: 'user',
      text: `<gugu_delivery route="chat" msg="msg:inserted" from="Reviewer" from_id="user:reviewer" chat="project" chat_kind="group"><![CDATA[${text}]]></gugu_delivery>`,
    } as TranscriptTurn['items'][number]);
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
    const t = await mount([first, longTurn('b', 1, 150)], undefined, theme);
    await until('inserted bubble is rendered', () => t.card('inserted') != null);
    const insertedTop = t.cardTop('inserted')!;
    expect(t.card('inserted')!.getBoundingClientRect().height, 'folded, but still several lines').toBeGreaterThan(120);
    for (let step = 0; step < 45; step++) {
      t.scrollEl.scrollTop = Math.max(0, insertedTop - 100 + step * 6);
      const previous = t.pinBottom('a-user');
      const inserted = t.card('inserted');
      if (previous !== null && inserted) expect(previous, `handoff step ${step}`).toBeLessThanOrEqual(inserted.getBoundingClientRect().top + 1);
    }
  });

  it('gives every user message of the running turn its own lane, not only the last one', async () => {
    // The running turn holds b and the message c inserted into it; before the fix only c was an
    // anchor, so a stayed stuck over all of b.
    const t = await mount([longTurn('a', 0, 150)], longTurn('b', 1, 150, ['c']));
    // Go to the message by its identity (not 100 px at a time through 150 items), then read past it.
    const stuckAfter = async (id: string) => {
      t.view.scrollToItem(id, { align: 'start', offset: -180 });
      await until(`${id} came into view`, () => t.cardTop(id), top => top !== null && top < 250 && top > 120);
      await t.scrollTo(t.scrollEl.scrollTop + 1500);
    };
    await stuckAfter('b-user');
    expect(t.pinTop('b-user'), 'b is stuck inside its part of the running turn').toBeCloseTo(PIN_LINE, 0);
    const aTop = t.pinTop('a-user');
    expect(aTop === null || aTop < 0, 'a left with its turn').toBe(true);
    await stuckAfter('c-user');
    expect(t.pinTop('c-user'), 'the inserted c takes over').toBeCloseTo(PIN_LINE, 0);
  });
  it('in the agent conversation, a delivered bubble ends the lane before it: the stuck copy neither slides under it nor leaves before it arrives', async () => {
    const delivered = longTurn('b', 1, 150);
    delivered.items[0] = { kind: 'message', id: 'b-user', seq: 0, role: 'user',
      text: '<gugu_delivery route="chat" msg="msg:b" from="小王" from_id="user:wang"><![CDATA[来自群里的一条消息]]></gugu_delivery>' } as TranscriptTurn['items'][number];
    // A long reply after it, so the delivered bubble can be scrolled all the way up to the stuck copy.
    delivered.items.push({ kind: 'message', id: 'b-final', seq: 151, role: 'assistant',
      text: Array.from({ length: 12 }, (_, i) => `b reply ${i}. Lorem ipsum dolor sit amet.`).join('\n\n') } as TranscriptTurn['items'][number]);
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
    const t = await mount([longTurn('a', 0, 150), delivered], undefined, theme);
    // 投进来的那条不是钉顶单元,在对话布局里画成右侧一个气泡:按它那一行找。
    const deliveredRow = () => t.host.querySelector<HTMLElement>('[data-row-kind="message"][data-item-id="b-user"]');
    const rowTop = () => { const el = deliveredRow(); return el ? el.getBoundingClientRect().top - t.scrollEl.getBoundingClientRect().top : null; };
    // Panel replies now remain in the outer transcript. Navigate by the original
    // identity instead of scanning their entire estimated height 80px at a time.
    t.view.scrollToItem('b-user', { align: 'start', offset: -120 });
    await until('the delivered bubble is below the pin line', () => ({ top: rowTop(), scrollTop: t.scrollEl.scrollTop }), value => value.top !== null && value.top < 260 && value.top > 80);
    const st = t.scrollEl.scrollTop;
    // MBP 验收 10-28:前一条打字消息的钉顶副本一直盖着投进来的那条。owner 11-22:它又在投进来那条的名字行碰到它时就被推走,
    // 气泡还隔着名字行和行距。被推走的那一刻,两个气泡之间只剩钉顶的留白。
    let pushed = false;
    for (let i = 0; i < 160 && !pushed; i++) {
      t.scrollEl.scrollTop = st + i * 2;
      const a = t.pinBottom('a-user'), bubble = t.card('b-user')!.getBoundingClientRect().top;
      if (a !== null) expect(a, `step ${i}`).toBeLessThanOrEqual(bubble - PIN_SUMMARY_GAP + 1);
      else {
        pushed = true;
        expect(t.summary('a-user')!.getBoundingClientRect().bottom, `step ${i}: pushed off by the bubble, not by the name above it`)
          .toBeCloseTo(bubble - PIN_SUMMARY_GAP, 0);
      }
    }
    expect(pushed, 'the delivered bubble pushed the stuck copy off').toBe(true);
  });

  // #2629: the reader's own message that came in as a delivery (a task started from a chat message) is drawn below its
  // sender's name (agent conversation) or the delivery card's padding (classic). Its summary rested as if neither were
  // there: over the attached file's name and above the bubble's top edge, a clipped second copy of its words.
  it.each([
    ['agent conversation', { preset: 'double', userGutter: 72, agentConversation: true }],
    ['classic', { preset: 'double', userGutter: 72 }],
  ] as const)('rests behind its own bubble, below the sender and the attachment of a delivered message (%s)', async (_, layout) => {
    const file = { itemId: 'pasted', version: 1, name: 'pasted-text.txt', mimeType: 'text/plain', sizeBytes: 18407 };
    const turn = (id: string, seq: number, text: string): TranscriptTurn => ({ id, seq, initiator: 'user', items: [
      { kind: 'message', id: `${id}-user`, seq: 0, role: 'user', text, files: [file] },
      { kind: 'message', id: `${id}-final`, seq: 1, role: 'assistant',
        text: Array.from({ length: 12 }, (_, i) => `${id} reply ${i}. Lorem ipsum dolor sit amet.`).join('\n\n') },
    ] as TranscriptTurn['items'] });
    const t = await mount([
      turn('a', 0, '<gugu_delivery route="chat" msg="msg:a" from="Me" from_id="user:me" from_type="human" chat="1" chat_kind="group"><![CDATA[Are the results out?]]></gugu_delivery>'),
      // Positive control: the same words and file sent from this session's composer.
      turn('b', 1, 'Are the results out?'),
    ], undefined, buildChatTheme(DEFAULT_CONFIG, layout), { userId: 'me', displayName: 'Me', guguNumber: 1 });
    for (const id of ['a-user', 'b-user']) {
      await t.view.scrollToItem(id, { align: 'start', offset: -100 });
      await until(`${id} on screen`, () => t.card(id), el => el != null);
      await untilStable(`${id} settled`, () => t.cardTop(id));
      expect(t.cardTop(id)!, `${id} rests below the pin line`).toBeGreaterThan(PIN_LINE);
      const card = t.card(id)!.getBoundingClientRect(), pin = t.summary(id)!.getBoundingClientRect();
      const label = t.card(id)!.closest('[data-index]')!.querySelector('[data-attachment-chip] > span:last-child')!.getBoundingClientRect();
      expect(pin.bottom, `${id}: the summary ends where its bubble ends`).toBeCloseTo(card.bottom, 1);
      expect(pin.top, `${id}: no part of the summary is above its bubble`).toBeGreaterThanOrEqual(card.top - 0.5);
      expect(pin.top, `${id}: the summary leaves the attachment's name uncovered`).toBeGreaterThanOrEqual(label.bottom - 0.5);
    }
    // Scrolled through, the delivered message is placed by the same rule as any other: T = min(max(P, b - h), e - h - gap).
    await t.view.scrollToItem('a-user', { align: 'start', offset: -100 });
    await untilStable('a settled', () => t.cardTop('a-user'));
    const edge = () => t.scrollEl.getBoundingClientRect().top;
    const lane = t.card('a-user')!.closest<HTMLElement>('[data-index]')!, summary = t.summary('a-user')!;
    const h = summary.getBoundingClientRect().height, from = Math.round(t.scrollEl.scrollTop);
    for (let st = from; st <= from + Math.round(lane.getBoundingClientRect().bottom - edge()); st += 3) {
      t.scrollEl.scrollTop = st;
      const card = t.card('a-user')!.getBoundingClientRect(), pin = summary.getBoundingClientRect();
      const b = card.bottom - edge(), e = lane.getBoundingClientRect().bottom - edge();
      expect(pin.top - edge(), `scrollTop=${st}`).toBeCloseTo(Math.min(Math.max(PIN_LINE, b - h), e - h - PIN_SUMMARY_GAP), 1);
      expect(card.bottom, `scrollTop=${st}: nothing of the bubble shows below its summary`).toBeLessThanOrEqual(pin.bottom + 0.01);
    }
  });

  it('pins a long message as the same two lines whether it is folded or expanded', async () => {
    const long: TranscriptTurn = { id: 'a', seq: 0, initiator: 'user', items: [
      { kind: 'message', id: 'a-user', seq: 0, role: 'user', text: 'A long question that folds. '.repeat(60) },
      // The agent conversation folds a turn's commentary into its process: one full final answer fills the turn.
      { kind: 'message', id: 'a-final', seq: 1, role: 'assistant',
        text: Array.from({ length: 150 }, (_, i) => `a reply ${i}. Lorem ipsum dolor sit amet.`).join('\n\n') },
    ] as TranscriptTurn['items'] };
    const theme = buildChatTheme(DEFAULT_CONFIG, { preset: 'double', userGutter: 72, agentConversation: true });
    const t = await mount([long, longTurn('b', 1, 150)], undefined, theme);
    t.host.querySelector<HTMLButtonElement>('[data-expand-user-card="a-final"]')!.click();
    await untilStable('the full final answer is measured', () => t.scrollEl.scrollHeight);
    const lineHeight = theme.fonts.body.lineHeight;
    const pinned = async () => {
      await t.scrollTo(t.scrollEl.scrollTop + 1200);
      await until('a is pinned', () => t.pinTop('a-user'), top => top !== null && Math.abs(top - PIN_LINE) < 1);
      return t.host.querySelector<HTMLElement>('[data-pin-summary="a-user"]')!.getBoundingClientRect().height;
    };
    const folded = await pinned();
    expect(folded, 'two lines and the bubble padding, not a screenful').toBeLessThan(3 * lineHeight + 32);
    const fade = (id: string) => getComputedStyle(t.host.querySelector(`[data-pin-summary="${id}"] > span`)!).maskImage;
    expect(fade('a-user'), 'a cut-off question fades out').toContain('gradient');
    expect(fade('b-user'), 'a question that fits does not').toBe('none');
    await t.scrollTo(0);
    t.card('a-user')!.click();
    await until('a expanded', () => t.card('a-user')!.getBoundingClientRect().height, h => h > 400);
    expect(await pinned(), 'expanding does not unpin or grow it').toBeCloseTo(folded, 0);
  });

  it('takes the reader back to the message when the summary is clicked', async () => {
    const t = await mount();
    await t.scrollTo(2600);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 0);
    t.host.querySelector<HTMLElement>('[data-pin-summary="a-user"]')!.click();
    await until('the message is back on screen', () => t.cardTop('a-user'), top => top !== null && top >= 0 && top < 120);
    await until('its summary is put away', () => pinnedSummaryShown(t.summary('a-user')!), shown => !shown);
  });
});
