/** @jsxImportSource solid-js */
/**
 * Chromium contract: while an agent reply streams, its settled blocks keep their DOM.
 *
 * The streaming parse keeps settled blocks object-stable so their rows survive each chunk. The bubble's copy text used
 * to take the full parse, which drops the streaming record: every chunk then re-parsed the whole reply and remounted
 * every block, and a reader's text selection in it vanished on the next chunk (owner, 2026-11-07).
 * Reading: a selection in the first paragraph survives later chunks. Positive control: the tail does grow.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

function liveTurn(words: number): TranscriptTurn {
  const text = `Settled paragraph. ${'It wraps across the bubble. '.repeat(6)}\n\nTail ${Array.from({ length: words }, (_, i) => `w${i}`).join(' ')}`;
  const items = [
    { kind: 'message', id: 'u', seq: 0, role: 'user', text: 'Explain.' },
    { kind: 'message', id: 'a', seq: 1, role: 'assistant', streaming: true, text },
  ] as TranscriptItem[];
  return { id: 'live', seq: 0, initiator: 'user', startedAt: 1000, items };
}

function textNode(root: Element, needle: string): Text | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.nodeValue?.includes(needle)) return node as Text;
  return null;
}

describe('streaming reply', () => {
  it('keeps a selection in a settled block while later chunks arrive', async () => {
    const context = createChatContext({ locale: () => 'en-US' });
    context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
    const state = createChatState(context);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:900px;height:900px';
    document.body.append(host);
    const view = createChatView({ context, state, parent: host, stickToBottom: true, commands: { conversationClock: () => 4000 } });
    disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });

    state.transcript.activeTurn.set(liveTurn(1), 'generating');
    await until('settled paragraph is painted', () => textNode(host, 'Settled paragraph'), Boolean);
    await untilStable('reply settles', () => host.textContent);
    const settled = textNode(host, 'Settled paragraph')!;
    const range = document.createRange();
    range.setStart(settled, 0);
    range.setEnd(settled, 'Settled'.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);

    for (const words of [2, 3, 4]) {
      state.transcript.activeTurn.set(liveTurn(words), 'generating');
      await until(`chunk ${words} is painted`, () => host.textContent?.includes(`w${words - 1}`), Boolean);
    }

    expect(settled.isConnected, 'the settled paragraph was rebuilt by a later chunk').toBe(true);
    expect(getSelection()!.toString()).toBe('Settled');
  });
});
