/** @jsxImportSource solid-js */
/**
 * Chromium contract: a reply the agent is still writing fades its new words in, in both rows a reply is drawn in (the
 * conversation card of the agent-conversation layout, and the assistant row).
 *
 * The fade lives in the html block and runs only under a StreamContext, which the row drawing the reply provides.
 * The conversation card once drew replies without one, so in the app's default layout no word ever faded while the
 * streaming-text contract (which mounts the block under a context of its own) passed.
 * Reading: `.gg-md-fresh` spans and their animation after the live reply grows, through the real view and state. The
 * reply item carries no `streaming` flag, as a host's transcript does not; the view marks the live turn's reply itself.
 * Control: the same reply committed fades nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

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
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 22000 } });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  return { state, host };
}

const fresh = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.gg-md-fresh')];

for (const agentConversation of [true, false]) {
  describe(`streaming fade (${agentConversation ? 'conversation card' : 'assistant row'})`, () => {
    it('fades the words a live reply grows by, and nothing in a committed one', async () => {
      const { state, host } = mount(agentConversation);
      state.transcript.activeTurn.set(turn('第一句话已经写好了。'));
      await until('first words on screen', () => host.textContent ?? '', (text) => text.includes('第一句话'));
      await untilStable('first words settle', () => host.scrollHeight);

      state.transcript.activeTurn.set(turn('第一句话已经写好了。第二句话 GROWN-MARK 刚刚到达。'));
      await until('grown words on screen', () => host.textContent ?? '', (text) => text.includes('GROWN-MARK'));
      const spans = fresh(host);
      expect(spans.map((span) => span.textContent).join(''), 'the grown words are wrapped to fade').toContain('GROWN-MARK');
      expect(spans.map((span) => getComputedStyle(span).animationName)).toEqual(spans.map(() => 'gg-md-fresh'));
    });

    it('fades nothing in a reply that mounts committed', async () => {
      const { state, host } = mount(agentConversation);
      state.transcript.history.seed([turn('写完的回复 DONE-MARK。', true)]);
      await until('committed reply on screen', () => host.textContent ?? '', (text) => text.includes('DONE-MARK'));
      expect(fresh(host)).toEqual([]);
    });
  });
}
