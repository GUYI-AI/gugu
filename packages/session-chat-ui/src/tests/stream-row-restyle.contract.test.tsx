/** @jsxImportSource solid-js */
/**
 * Chromium contract: a streaming reply never changes a custom property on an element that wraps its body.
 *
 * A custom property inherits, so changing one on the row root restyles every node of the reply. The rows used to hand
 * their engine height down that way, and the height changes on every streamed chunk: per chunk the browser restyled the
 * whole reply. On a 15k-char LaTeX reply style recalc grew from 5.6 to 63 ms per chunk along the reply (2026-11-12),
 * the renderer stayed busy long enough to drop every host connection, and the reply vanished.
 * Reading: the inline custom properties of every ancestor of the reply text, before and after more text streams in.
 * Positive control: the row's own height did change between the two readings.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

const PARAGRAPH = '梯度 $\\nabla_\\theta J=\\frac{1}{m}X^T(X\\theta-y)$，学习率 $\\alpha=0.01$，正则项 $\\lambda\\|\\theta\\|_2^2$。';

function liveTurn(paragraphs: number, marker: string): TranscriptTurn {
  const text = Array.from({ length: paragraphs }, (_, i) => `${i + 1}. ${PARAGRAPH}`).join('\n\n') + `\n\n${marker}`;
  return { id: 'live', seq: 0, initiator: 'user', startedAt: 1000, items: [
    { kind: 'message', id: 'u', seq: 0, role: 'user', text: '复习' },
    { kind: 'message', id: 'a', seq: 1, role: 'assistant', text, streaming: true },
  ] } as TranscriptTurn;
}

/** Every element from the reply's marker text up to the host, with its inline custom properties. */
function ancestorsOf(host: HTMLElement, marker: string): Map<Element, string> {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let node: Node | null = null;
  while ((node = walker.nextNode())) if (node.textContent?.includes(marker)) break;
  const out = new Map<Element, string>();
  for (let el = node?.parentElement ?? null; el && el !== host; el = el.parentElement) {
    const style = (el as HTMLElement).style;
    const custom: string[] = [];
    for (let i = 0; i < style.length; i++) if (style[i]!.startsWith('--')) custom.push(`${style[i]}:${style.getPropertyValue(style[i]!)}`);
    out.set(el, custom.join(';'));
  }
  return out;
}

for (const agentConversation of [true, false]) {
  describe(`streaming reply restyle (${agentConversation ? 'conversation card' : 'assistant row'})`, () => {
    it('keeps the custom properties above the reply body constant while it grows', async () => {
      const context = createChatContext({ locale: () => 'zh-CN' });
      context.setLayout({ preset: 'double', userGutter: 72, agentConversation });
      const state = createChatState(context);
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:0;width:900px;height:1000px';
      document.body.append(host);
      const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 22000 } });
      disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });

      state.transcript.activeTurn.set(liveTurn(3, 'MARK-ONE'));
      await until('first reply on screen', () => host.textContent ?? '', (text) => text.includes('MARK-ONE'));
      await untilStable('first reply settles', () => host.scrollHeight);
      const before = ancestorsOf(host, 'MARK-ONE');
      const heightsBefore = new Map([...before.keys()].map((el) => [el, (el as HTMLElement).style.height]));

      state.transcript.activeTurn.set(liveTurn(8, 'MARK-TWO'));
      await until('grown reply on screen', () => host.textContent ?? '', (text) => text.includes('MARK-TWO'));
      await untilStable('grown reply settles', () => host.scrollHeight);
      const after = ancestorsOf(host, 'MARK-TWO');

      const kept = [...before.keys()].filter((el) => after.has(el));
      expect(kept.length, 'the reply was remounted instead of growing in place').toBeGreaterThan(0);
      expect(kept.some((el) => (el as HTMLElement).style.height !== '' && (el as HTMLElement).style.height !== heightsBefore.get(el)),
        'positive control: some ancestor of the reply carries the engine height and it changed').toBe(true);
      const changed = kept.filter((el) => before.get(el) !== after.get(el))
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}: ${before.get(el)} → ${after.get(el)}`);
      expect(changed).toEqual([]);
    });
  });
}
