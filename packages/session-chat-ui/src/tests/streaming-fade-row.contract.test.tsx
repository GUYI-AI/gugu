/** @jsxImportSource solid-js */
/**
 * Chromium contract: a reply the agent is still writing fades in the words that arrive while its row is on screen,
 * in both rows a reply is drawn in (the conversation card of the agent-conversation layout, and the assistant row), and
 * nothing else: what the reply already says when its row mounts is drawn as it is.
 *
 * The fade lives in the html block and runs only under a StreamContext, which the row drawing the reply provides.
 * The conversation card once drew replies without one, so in the app's default layout no word ever faded while the
 * streaming-text contract (which mounts the block under a context of its own) passed. The assistant row faded the
 * whole reply each time it mounted, so switching back to a chat mid-reply replayed the fade over text already read.
 * Reading: `.gg-md-fresh` spans and their animation, through the real view and state; the switch is the view's own
 * model swap. The reply item carries no `streaming` flag, as a host's transcript does not; the view marks the live
 * turn's reply itself. Control: a committed reply fades nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

const FIRST = '第一句话已经写好了。';

function turn(text: string, done = false): TranscriptTurn {
  return { id: 'live', seq: 0, initiator: 'user', startedAt: 1000, items: [
    { kind: 'message', id: 'u', seq: 0, role: 'user', text: '介绍一下' },
    { kind: 'message', id: 'a', seq: 1, role: 'assistant', text },
  ], ...(done ? { outcome: { kind: 'done' } } : {}) } as TranscriptTurn;
}

function mount(agentConversation: boolean) {
  const context = createChatContext({ locale: () => 'zh-CN' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation });
  const state = createChatState(context);
  const elsewhere = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 22000 } });
  disposers.push(() => { view.dispose(); state.dispose(); elsewhere.dispose(); context.dispose(); host.remove(); });
  return { state, elsewhere, view, host };
}

const freshText = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.gg-md-fresh')].map((span) => span.textContent).join('');
const animations = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.gg-md-fresh')].map((span) => getComputedStyle(span).animationName);

async function shows(host: HTMLElement, mark: string) {
  await until(`${mark} on screen`, () => host.textContent ?? '', (text) => text.includes(mark));
}

for (const agentConversation of [true, false]) {
  describe(`streaming fade (${agentConversation ? 'conversation card' : 'assistant row'})`, () => {
    it('fades only the words that arrive after the row mounts', async () => {
      const { state, host } = mount(agentConversation);
      state.transcript.activeTurn.set(turn(FIRST));
      await shows(host, '第一句话');
      await untilStable('first words settle', () => host.textContent);
      expect(freshText(host), 'the words the row mounted with fade').toBe('');

      state.transcript.activeTurn.set(turn(`${FIRST}第二句话 GROWN-MARK 刚刚到达。`));
      await shows(host, 'GROWN-MARK');
      expect(freshText(host), 'the arriving words are wrapped to fade').toContain('GROWN-MARK');
      expect(freshText(host)).not.toContain('第一句话');
      expect(animations(host)).toEqual(animations(host).map(() => 'gg-md-fresh'));
    });

    it('does not replay the fade when the chat is switched away and back', async () => {
      const { state, elsewhere, view, host } = mount(agentConversation);
      state.transcript.activeTurn.set(turn(FIRST));
      await shows(host, '第一句话');
      state.transcript.activeTurn.set(turn(`${FIRST}SEEN-MARK 读过了。`));
      await shows(host, 'SEEN-MARK');

      view.setModel(elsewhere);
      await until('switched away', () => host.textContent ?? '', (text) => !text.includes('SEEN-MARK'));
      view.setModel(state);
      await shows(host, 'SEEN-MARK');
      await untilStable('switched back', () => host.textContent);
      expect(freshText(host), 'text already there when switched back fades again').toBe('');

      state.transcript.activeTurn.set(turn(`${FIRST}SEEN-MARK 读过了。AFTER-MARK 新到的。`));
      await shows(host, 'AFTER-MARK');
      expect(freshText(host), 'words arriving after the switch back fade').toContain('AFTER-MARK');
      expect(freshText(host)).not.toContain('SEEN-MARK');
    });

    it('fades nothing in a reply that mounts committed', async () => {
      const { state, host } = mount(agentConversation);
      state.transcript.history.seed([turn('写完的回复 DONE-MARK。', true)]);
      await shows(host, 'DONE-MARK');
      expect(freshText(host)).toBe('');
    });
  });
}
