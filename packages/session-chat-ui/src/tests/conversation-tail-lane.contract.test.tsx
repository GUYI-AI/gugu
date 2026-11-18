/** @jsxImportSource solid-js */
/** Appending and rebuilding reserve the same distance after the previous utterance's final row. */
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

function seam(host: HTMLElement): number {
  const rows = [...host.querySelectorAll<HTMLElement>('[data-row-kind]')].filter(row => row.offsetHeight > 0)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  const index = rows.findIndex(row => row.querySelector('[data-user-card="next"]'));
  const next = rows[index]!;
  const preceding = rows[index - 1]!;
  return Math.round(next.getBoundingClientRect().top + parseFloat(getComputedStyle(next).paddingTop)
    - preceding.getBoundingClientRect().bottom);
}

describe('the next user message starts 24px after the previous utterance', () => {
  it.each(['rebuilt', 'appended'] as const)('%s: a hidden action row reserves its space', async (mode) => {
    const { host } = await mount(turn('t1', 0, [user('u'), bash, reply('Done: short answer.')]), mode);
    expect(seam(host)).toBe(24);
  });

  it.each(['rebuilt', 'appended'] as const)('%s: an action row with a collapse control reserves the same space', async (mode) => {
    const { host } = await mount(turn('t1', 0, [user('u'), bash, reply(LONG)]), mode, true);
    expect(host.querySelector('[data-collapse-id="conversation-bubble:r"]'), 'the reply above shows its collapse control').not.toBeNull();
    expect(seam(host)).toBe(24);
  });

  it.each(['rebuilt', 'appended'] as const)('%s: the file group ends at its action row', async (mode) => {
    const { host } = await mount(turn('t1', 0, [user('u'), edit('e1', '/p/a.txt'), edit('e2', '/p/b.txt'), reply('Done.')]), mode);
    expect(seam(host)).toBe(24);
  });

  // A second delivery from the same sender puts its quote in the footer.
  it.each(['rebuilt', 'appended'] as const)('%s: a quote in the footer does not alter the seam', async (mode) => {
    const { host } = await mount(turn('t1', 0, [delivered('d1', 'user:peer'), delivered('d2', 'user:peer', true)]), mode, false, '[data-user-card="d2"]');
    expect(seam(host)).toBe(24);
  });

  it.each(['rebuilt', 'appended'] as const)('%s: the next utterance starts at the same distance with a quoted header', async (mode) => {
    const { host } = await mount(turn('t1', 0, [delivered('d1', 'user:other'), delivered('d2', 'user:peer', true)]), mode, false, '[data-user-card="d2"]');
    expect(seam(host)).toBe(24);
  });

  // 「收起全文」只看展开标记(不再量正文高度),所以标记只能落在放不下的气泡上:最新那条让出位置时,短的不留标记。
  it.each([['a short reply', 'Done: short answer.', false], ['a long reply', LONG, true]] as const)(
    'the expanded mark stays only on %s that overflows once it stops being the latest', async (_name, text, held) => {
      const { host, state } = await mount(turn('t1', 0, [user('u'), bash, reply(text)]), 'appended');
      expect(state.viewState.isCollapsed('conversation-bubble:r')).toBe(held);
      expect(host.querySelector('[data-collapse-id="conversation-bubble:r"]') !== null).toBe(held);
    });
});
