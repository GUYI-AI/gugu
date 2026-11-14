/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { paintedFrames } from './painted-frames';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const turn = (seq: number): TranscriptTurn => ({ id: `stored-${seq}`, seq, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id: `input-${seq}`, seq: 0, role: 'user', text: 'A new question.' },
  { kind: 'message', id: `answer-${seq}`, seq: 1, role: 'assistant', text: 'An answer that takes a few lines.\n\n'.repeat(6) },
] });

describe('a send at the tail', () => {
  it('is followed in the frame its rows mount, though the composer asks for a smooth return to the end', async () => {
    const context = createChatContext({ locale: () => 'en-US' });
    context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
    const state = createChatState(context);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:900px;height:800px';
    document.body.append(host);
    const view = createChatView({ context, state, parent: host });
    disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
    state.transcript.history.seed(Array.from({ length: 12 }, (_, i) => turn(i)));
    const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    const gap = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
    await until('the reader is at the tail', () => !!host.querySelector('[data-user-card="answer-11"]') && gap() < 1);
    await untilStable('geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
    // What every frame paints from the send on, once the sent message is mounted: the end of the conversation.
    const gaps = paintedFrames(() => host.querySelector('[data-user-card="input-12"]') ? gap() : undefined);
    view.scrollToBottom({ behavior: 'smooth' });
    state.transcript.activeTurn.set({ id: 'sent', seq: 12, initiator: 'user', items: [{ kind: 'message', id: 'input-12', seq: 0, role: 'user', text: 'Thanks.' }] }, 'generating');
    await until('the sent message is drawn', () => gaps.frames.length > 0);
    await untilStable('geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
    gaps.stop();
    expect(gaps.frames.filter(value => value >= 1)).toEqual([]);
  });
});
