/** @jsxImportSource solid-js */
/**
 * #2587 (owner 2026-11-13):「三类消息之前是会创建新的气泡段落，现在是接续之前气泡段落」
 * 「但是比如 A2A 消息或者用户消息造成的分割，还是会分割消息气泡」
 *
 * An agent turn woken by its own finished background task continues the answered turn on screen: the process line that
 * is already there turns live again, ❌ a second line that only merges once the run ends — and nothing jumps at commit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { batch } from 'solid-js';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

const bash = (id: string, seq: number): TranscriptItem => ({ kind: 'execute-tool-call', id, seq,
  toolCallId: id, title: `echo ${id}`, command: `echo ${id}`, status: 'done' });
const answered: TranscriptTurn = { id: 'answered', seq: 0, initiator: 'user', startedAt: 1000, endedAt: 4000, outcome: { kind: 'done' }, items: [
  { kind: 'message', id: 'input', seq: 0, role: 'user', text: 'Run the fixture.' },
  bash('first-command', 1),
  { kind: 'message', id: 'answer', seq: 2, role: 'assistant', text: 'Started it; waiting for the background run.' },
] };
const woken = (trigger: TranscriptTurn['trigger'], done: boolean, n = 1): TranscriptTurn => {
  const at = 60000 * n, tag = n === 1 ? '' : `-${n}`;
  return { id: `woken${tag}`, seq: n, initiator: 'agent', trigger,
    startedAt: at, ...(done ? { endedAt: at + 5000, outcome: { kind: 'done' as const } } : {}), items: [
      { kind: 'background-command-done-tool-call', id: `finished${tag}`, seq: 0, toolCallId: `bg${tag}`, launchToolCallId: 'first-command',
        title: 'echo first-command', name: 'echo first-command', status: 'done', outcome: 'completed', at },
      bash(`second-command${tag}`, 1),
      { kind: 'message', id: `later${tag}`, seq: 2, role: 'assistant', text: n === 1 ? 'The background run passed.' : `Wake ${n} is done.` },
    ] };
};

function mount() {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:2000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 62000 } });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.history.seed([answered]);
  return { host, state, settle: () => untilStable('layout settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height) };
}
const heads = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-conversation-part="head"]')];
const bodies = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[data-conversation-part="body"]')].map(el => el.textContent ?? '');

describe('a turn woken by its own finished task continues the answered segment (#2587)', () => {
  it('turns the answered process line live, keeps it through the commit, and never shows a standalone completion row', async () => {
    const v = mount();
    await until('the answer is on screen', () => bodies(v.host).some(text => text.includes('Started it')));
    v.state.transcript.activeTurn.set(woken({ kind: 'agent' }, false));
    await until('the woken words replace the earlier answer as the bubble', () => bodies(v.host).some(text => text.includes('The background run passed.')));
    expect(heads(v.host)).toHaveLength(1);
    expect(bodies(v.host).some(text => text.includes('Started it'))).toBe(false);
    expect(v.host.querySelector('[data-conversation-step="finished"]')).toBeNull();
    // The answered turn's own process line is the live one (its id), running again (the grid loader replaces the brain).
    expect(v.host.querySelector('[data-conversation-process]')?.getAttribute('data-conversation-process')).toBe('answered:process');
    expect(v.host.querySelector('[data-conversation-process] svg')).toBeNull();
    await v.settle();
    const top = heads(v.host)[0]!.getBoundingClientRect().top;

    batch(() => {
      v.state.transcript.history.append([woken({ kind: 'agent' }, true)]);
      v.state.transcript.activeTurn.set(null);
    });
    await v.settle();
    expect(heads(v.host)).toHaveLength(1);
    expect(heads(v.host)[0]!.getBoundingClientRect().top).toBe(top);
    expect(bodies(v.host).filter(text => text.includes('The background run passed.'))).toHaveLength(1);
    expect(v.host.querySelector('[data-conversation-step="finished"]')).toBeNull();
  });

  // The line's own key reads inverted while live (`turnProcessExpanded`): reused as is, an opened line would close at
  // the wake and open again at the end (mac1 real window, 2026-11-13). While the woken run goes the line is open (the
  // live default) and the reader can still close it; once the run is over it is closed, whatever the reader did before
  // (owner 2026-11-13:「你跑完怎么不合起来」).
  for (const opened of [false, true]) it(`an ${opened ? 'opened' : 'unopened'} line is open while the woken run goes, then closed`, async () => {
    const v = mount();
    const expanded = () => v.host.querySelector('[data-conversation-process]')?.getAttribute('aria-expanded');
    await until('the answer is on screen', () => bodies(v.host).some(text => text.includes('Started it')));
    if (opened) v.state.viewState.setCollapsed('answered:process', true);
    await until('the line shows as the reader left it', () => expanded() === String(opened));
    v.state.transcript.activeTurn.set(woken({ kind: 'agent' }, false));
    await until('the woken words replace the earlier answer as the bubble', () => bodies(v.host).some(text => text.includes('The background run passed.')));
    expect(expanded()).toBe('true');
    v.host.querySelector<HTMLElement>('[data-conversation-process]')!.click();
    await until('the reader closes the running line', () => expanded() === 'false');
    v.host.querySelector<HTMLElement>('[data-conversation-process]')!.click();
    await until('and opens it again', () => expanded() === 'true');

    batch(() => {
      v.state.transcript.history.append([woken({ kind: 'agent' }, true)]);
      v.state.transcript.activeTurn.set(null);
    });
    await v.settle();
    expect(heads(v.host)).toHaveLength(1);
    expect(expanded()).toBe('false');
  });

  // The owner's run (2026-11-13): between two wakes the line rests closed; the reader opened it there, the next wake ran
  // and finished, and the line stayed open. Opened while the run is still coming back, it closes when the run is over;
  // opened after that, it stays as the reader left it.
  it('closes a line the reader opened between two wakes once the later wake is over, and keeps one opened afterwards', async () => {
    const v = mount();
    const expanded = () => v.host.querySelector('[data-conversation-process]')?.getAttribute('aria-expanded');
    await until('the answer is on screen', () => bodies(v.host).some(text => text.includes('Started it')));
    batch(() => {
      v.state.transcript.history.append([woken({ kind: 'agent' }, true)]);
      v.state.transcript.activeTurn.set(null);
    });
    await until('the first wake is over and its line rests closed', () => bodies(v.host).some(text => text.includes('The background run passed.')) && expanded() === 'false');
    v.host.querySelector<HTMLElement>('[data-conversation-process]')!.click();
    await until('the reader opens it while the second command is still out', () => expanded() === 'true');

    v.state.transcript.activeTurn.set(woken({ kind: 'agent' }, false, 2));
    await until('the second wake answers on the same line', () => bodies(v.host).some(text => text.includes('Wake 2 is done.')));
    expect(heads(v.host)).toHaveLength(1);
    expect(expanded()).toBe('true');
    batch(() => {
      v.state.transcript.history.append([woken({ kind: 'agent' }, true, 2)]);
      v.state.transcript.activeTurn.set(null);
    });
    await v.settle();
    expect(heads(v.host)).toHaveLength(1);
    expect(expanded()).toBe('false');

    v.host.querySelector<HTMLElement>('[data-conversation-process]')!.click();
    await until('opened after the run is over', () => expanded() === 'true');
    await v.settle();
    expect(expanded()).toBe('true');
  });

  it('still opens a new segment for a turn a delivery started', async () => {
    const v = mount();
    await until('the answer is on screen', () => bodies(v.host).some(text => text.includes('Started it')));
    v.state.transcript.activeTurn.set(woken({ kind: 'delivery', chatIds: ['206258'] }, false));
    await until('the delivery turn answers', () => bodies(v.host).some(text => text.includes('The background run passed.')));
    expect(heads(v.host)).toHaveLength(2);
    expect(bodies(v.host).some(text => text.includes('Started it'))).toBe(true);
  });
});
