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
import { DEFAULT_CONFIG, buildChatTheme } from '@session-chat/core/config';
import type { ChatItem, TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { afterEach, describe, expect, it } from 'vitest';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { pinnedSummaryShown } from '../../../../tests/support/pinnedSummaryShown';

/** Where a stuck summary's top sits, below the scroller's top edge. */
const PIN_LINE = UNIT_REGISTRY.message!.margin!.top!;

const teardown: Array<() => void> = [];
afterEach(() => {
  while (teardown.length) teardown.pop()?.();
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
  theme = DEFAULT_THEME
) {
  const context = createChatContext({ locale: () => 'en-US', theme });
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
  await until('transcript mounted', () => card('a-user') != null);
  await scrollTo(0);
  return { host, scrollEl, card, cardTop, summary, pinTop, pinBottom, mounted, scrollTo, view };
}

describe('sticky user lanes', () => {
  it('never shows the lines its summary repeats, in the same frame as any scroll write', async () => {
    const t = await mount();
    const lane = t.card('a-user')!.closest<HTMLElement>('[data-index]')!;
    const edge = () => t.scrollEl.getBoundingClientRect().top;
    const shown = () => pinnedSummaryShown(t.summary('a-user')!);
    const cover = () => lane.querySelector<HTMLElement>('[data-chat-pin-backdrop]')!.getBoundingClientRect();
    expect(shown(), 'the message is on screen').toBe(false);
    const handOver = Math.round(t.scrollEl.scrollTop + t.cardTop('a-user')!);
    await t.scrollTo(handOver + 150);
    expect(shown(), 'stuck before the sweep').toBe(true);
    const repeats = t.summary('a-user')!.getBoundingClientRect().height;
    // Sweep back over the hand-over and forth, reading right after each write: no frame runs in between, so the
    // drawn-or-not flag is a frame late, as it is under load. Wherever the message's first lines are on screen
    // while the summary is drawn, the summary's opaque layer is over them.
    const down = Array.from({ length: 91 }, (_, i) => handOver - 120 + 3 * i);
    let covered = 0;
    for (const st of [...[...down].reverse(), ...down]) {
      t.scrollEl.scrollTop = st;
      if (!shown()) continue;
      const card = t.card('a-user')!.getBoundingClientRect();
      const top = Math.max(card.top, edge()), bottom = card.top + repeats;
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
    expect(getComputedStyle(lane.querySelector('[data-chat-pin-backdrop]')!).opacity).toBe('1');
    expect(cover().top, 'the strip is opaque from the scroller edge').toBeLessThanOrEqual(edge() + 0.5);
    expect(t.pinTop('a-user')).toBeCloseTo(PIN_LINE, 0);
    expect(t.cardTop('a-user')!, 'the message itself scrolled away').toBeLessThan(0);
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
    const stuckAfter = async (id: string) => {
      let st = t.scrollEl.scrollTop;
      while (!(t.cardTop(id) !== null && t.cardTop(id)! < 250 && t.cardTop(id)! > 120)) {
        st += 100;
        expect(st, `${id} came into view`).toBeLessThan(40_000);
        await t.scrollTo(st);
      }
      await t.scrollTo(st + 1500);
    };
    await stuckAfter('b-user');
    expect(t.pinTop('b-user'), 'b is stuck inside its part of the running turn').toBeCloseTo(PIN_LINE, 0);
    const aTop = t.pinTop('a-user');
    expect(aTop === null || aTop < 0, 'a left with its turn').toBe(true);
    await stuckAfter('c-user');
    expect(t.pinTop('c-user'), 'the inserted c takes over').toBeCloseTo(PIN_LINE, 0);
  });
  it('in the agent conversation, a delivered bubble ends the lane before it instead of sliding under its stuck copy', async () => {
    const delivered = longTurn('b', 1, 150);
    delivered.items[0] = { kind: 'message', id: 'b-user', seq: 0, role: 'user',
      text: '<gugu_delivery route="chat" msg="msg:b" from="小王" from_id="user:wang"><![CDATA[来自群里的一条消息]]></gugu_delivery>' } as TranscriptTurn['items'][number];
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
    // MBP 验收 10-28:前一条打字消息的钉顶副本一直盖着投进来的那条。
    for (let i = 0; i < 40; i++) {
      t.scrollEl.scrollTop = st + i * 6;
      const a = t.pinBottom('a-user');
      if (a !== null) expect(a, `step ${i}`).toBeLessThanOrEqual(deliveredRow()!.getBoundingClientRect().top + 1);
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
