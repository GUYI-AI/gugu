/** @jsxImportSource solid-js */
/**
 * 对话布局:一条用户消息离上一行墨迹的实画距离。上一条消息的尾行是空白(悬停才显时间、复制)时,尾行本身就是那 20;
 * 尾行里有常驻的「收起全文」时,它是墨迹,间距得另外给。回合末尾是「已编辑」卡时按接缝给 8。
 * 增量追加(这一轮正在跑)和整条重建(重启、再进来)画出来一样。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { textFilePatch } from '@gugu/session-core/lib';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(dispose => dispose()));

const LONG = Array.from({ length: 30 }, (_, i) => `Paragraph ${i}: the module now uses a single token path and every caller was updated.`).join('\n\n');
const user = (id: string): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'user', text: `question ${id}` });
const reply = (text: string): ChatMessage => ({ kind: 'message', id: 'r', seq: 9, role: 'assistant', text, at: 5000 });
const bash: ChatItem = { kind: 'execute-tool-call', id: 'b', seq: 1, toolCallId: 'b', title: 'bash', status: 'done' } as unknown as ChatItem;
const edit = (id: string, path: string): ChatItem => ({ kind: 'diff', id, seq: 2, patches: [textFilePatch(path, 'a', 'b')], status: 'done' } as unknown as ChatItem);
/** A message delivered from a group member; `quote` gives it a reply reference. */
const delivered = (id: string, from: string, quote = false): ChatMessage => ({ kind: 'message', id, seq: 0, role: 'user',
  text: `<gugu_delivery route="chat" msg="msg:${id}" from="Peer" from_id="${from}"><![CDATA[hello from ${id}]]></gugu_delivery>`,
  ...(quote ? { conversationReply: { itemId: 'src', text: 'the line being answered', fromId: 'user:owner' } } : {}) });
const turn = (id: string, seq: number, items: ChatItem[]): TranscriptTurn => ({ id, seq, initiator: 'user', startedAt: 1000, endedAt: 9000,
  items: items as TranscriptTurn['items'], outcome: { kind: 'done' } } as TranscriptTurn);

type Mode = 'rebuilt' | 'appended';

async function mount(first: TranscriptTurn, mode: Mode, expandReply = false, drawn = '[data-user-card="r"], [data-row-kind="file-change-summary"]') {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context), host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:5000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationAgentName: () => 'Fixture agent' } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  if (expandReply) state.viewState.setCollapsed('conversation-bubble:r', true);
  const next = turn('t2', 1, [user('next')]);
  if (mode === 'rebuilt') state.transcript.history.seed([first, next]);
  else {
    state.transcript.history.seed([first]);
    await until('the first turn is drawn', () => host.querySelector(drawn) !== null);
    state.transcript.activeTurn.set({ ...next, endedAt: undefined, outcome: undefined } as TranscriptTurn, 'generating');
  }
  await until('the next message is drawn', () => host.querySelector('[data-user-card="next"]') !== null);
  await untilStable('the transcript settles', () => host.querySelector<HTMLElement>('[data-chat-canvas]')?.offsetHeight);
  return { host, state };
}

/** Painted extent of a row: text, images and filled or bordered boxes that are visible, clipped by overflowing ancestors. */
function ink(root: Element): [number, number] {
  let top = Infinity, bottom = -Infinity;
  const visible = (e: Element) => { for (let x: Element | null = e; x && x !== document.body; x = x.parentElement) {
    const c = getComputedStyle(x); if (c.opacity === '0' || c.visibility === 'hidden' || c.display === 'none') return false; } return true; };
  const painted = (e: Element, c: CSSStyleDeclaration) => c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.borderTopWidth !== '0px'
    || ['IMG', 'svg'].includes(e.tagName) || [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim());
  const visit = (e: Element) => {
    const r = e.getBoundingClientRect();
    if (r.height > 0 && painted(e, getComputedStyle(e)) && visible(e)) {
      let t = r.top, b = r.bottom;
      for (let x = e.parentElement; x && x !== root.parentElement; x = x.parentElement) {
        if (getComputedStyle(x).overflowY !== 'visible') { const q = x.getBoundingClientRect(); t = Math.max(t, q.top); b = Math.min(b, q.bottom); }
      }
      if (b > t) { top = Math.min(top, t); bottom = Math.max(bottom, b); }
    }
    for (const c of e.children) visit(c);
  };
  visit(root);
  return [top, bottom];
}

function seam(host: HTMLElement): { gapBefore: number; painted: number } {
  const rows = [...host.querySelectorAll<HTMLElement>('[data-row-kind]')].filter(r => r.offsetHeight > 0)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const i = rows.findIndex(r => r.querySelector('[data-user-card="next"]'));
  let above = -Infinity;
  for (let j = i - 1; j >= 0 && above === -Infinity; j--) above = ink(rows[j])[1];
  return { gapBefore: parseFloat(getComputedStyle(rows[i]).paddingTop), painted: Math.round(ink(rows[i])[0] - above) };
}

describe('the next user message keeps its distance from what the turn above painted', () => {
  it.each(['rebuilt', 'appended'] as const)('%s: a blank tail lane is the 20 itself (control)', async (mode) => {
    const { host } = await mount(turn('t1', 0, [user('u'), bash, reply('Done: short answer.')]), mode);
    expect(seam(host)).toEqual({ gapBefore: 0, painted: 20 });
  });

  it.each(['rebuilt', 'appended'] as const)('%s: a lane that shows 「收起全文」 is ink, so the gap is still 20', async (mode) => {
    const { host } = await mount(turn('t1', 0, [user('u'), bash, reply(LONG)]), mode, true);
    expect(host.querySelector('[data-collapse-id="conversation-bubble:r"]'), 'the reply above shows its collapse control').not.toBeNull();
    expect(seam(host)).toEqual({ gapBefore: 20, painted: 20 });
  });

  it.each(['rebuilt', 'appended'] as const)('%s: after an "edited files" card the seam is 8', async (mode) => {
    const { host } = await mount(turn('t1', 0, [user('u'), edit('e1', '/p/a.txt'), edit('e2', '/p/b.txt'), reply('Done.')]), mode);
    expect(seam(host)).toEqual({ gapBefore: 8, painted: 8 });
  });

  // 引用在不在脚注,flatten 和头部布局问同一个函数:同一个人接着投来的第二条不再画名字,引用落到脚注里,是墨迹。
  it.each(['rebuilt', 'appended'] as const)('%s: a quote in the footer (same sender again, no name) is ink, so the gap is still 20', async (mode) => {
    const { host } = await mount(turn('t1', 0, [delivered('d1', 'user:peer'), delivered('d2', 'user:peer', true)]), mode, false, '[data-user-card="d2"]');
    const { gapBefore, painted } = seam(host);
    // 脚注那行字的墨迹比尾行底边高 1px,所以实画是 21;要钉的是「不贴上」。
    expect(gapBefore).toBe(20);
    expect(painted).toBeGreaterThanOrEqual(20);
  });

  it.each(['rebuilt', 'appended'] as const)('%s: with a new sender the name carries the quote in the header, and the blank lane is the 20 (control)', async (mode) => {
    const { host } = await mount(turn('t1', 0, [delivered('d1', 'user:other'), delivered('d2', 'user:peer', true)]), mode, false, '[data-user-card="d2"]');
    expect(seam(host)).toEqual({ gapBefore: 0, painted: 20 });
  });

  // 「收起全文」只看展开标记(不再量正文高度),所以标记只能落在放不下的气泡上:最新那条让出位置时,短的不留标记。
  it.each([['a short reply', 'Done: short answer.', false], ['a long reply', LONG, true]] as const)(
    'the expanded mark stays only on %s that overflows once it stops being the latest', async (_name, text, held) => {
      const { host, state } = await mount(turn('t1', 0, [user('u'), bash, reply(text)]), 'appended');
      expect(state.viewState.isCollapsed('conversation-bubble:r')).toBe(held);
      expect(host.querySelector('[data-collapse-id="conversation-bubble:r"]') !== null).toBe(held);
    });
});
