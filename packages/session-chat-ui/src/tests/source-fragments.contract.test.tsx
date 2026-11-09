/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { createChatState } from '../state/chat-state';
import type { TranscriptTurn } from '../model';
import { fragmentAnchor } from '../state/source-fragments';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
async function mountSource() {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  const fragments = Array.from({ length: 7 }, (_, i) => ({ key: `record-${i}`,
    sourceRange: { start: i * 1000, end: i * 1000 + 999 }, ownership: 'unresolved' as const,
    text: `Record ${i}\n\n${'Bounded source body.\n\n'.repeat(18)}` }));
  const sourceWindow = { sourceLineage: 'source', sourceFragments: fragments };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:400px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { sourceWindow } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  await until('source body is actually rendered', () => host.querySelector('[data-source-fragment]') !== null);
  const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const settle = () => untilStable('source row geometry settles', () => [scroller.scrollTop, scroller.scrollHeight]);
  const resolve = () => {
    state.transcript.history.seed([{ id: 'real-turn', seq: 0, initiator: 'agent', items: [
      { kind: 'message', id: 'real-item', seq: 0, role: 'assistant', text: fragments[2].text },
    ] } satisfies TranscriptTurn]);
    view.setCommands({ sourceWindow: { ...sourceWindow,
      resolvedFragmentOwners: [{ fragmentKey: fragments[2].key, turnId: 'real-turn', itemId: 'real-item' }],
    } });
  };
  return { host, view, scroller, settle, resolve };
}

it('replaces a real source body with one canonical row, without duplicating either', async () => {
  const { host, view, settle, resolve } = await mountSource();
  view.setScrollMode({ kind: 'anchor', itemId: fragmentAnchor('record-2'), edge: 'top', offset: 0 });
  await settle();
  expect(host.querySelector('[data-source-fragment="record-2"]')?.textContent).toContain('Bounded source body.');
  expect(host.querySelector('[data-source-fragment="record-2"] [data-agent-conversation-message]')).toBeNull();
  resolve();
  await until('canonical replacement is painted', () => host.querySelector('[data-item-id="real-item"]') !== null);
  await settle();
  expect(host.querySelectorAll('[data-item-id="real-item"]')).toHaveLength(1);
  expect(host.querySelector('[data-source-fragment="record-2"]')).toBeNull();
});

it('keeps the visible row at the same viewport offset when ownership resolves during upward reading', async () => {
  const { host, view, scroller, settle, resolve } = await mountSource();
  view.setScrollMode({ kind: 'anchor', itemId: fragmentAnchor('record-2'), edge: 'top', offset: 24 });
  await settle();
  expect(scroller.scrollTop).toBeGreaterThan(0);
  expect(scroller.scrollTop).toBeLessThan(scroller.scrollHeight - scroller.clientHeight);
  const before = host.querySelector(`[data-item-id="${fragmentAnchor('record-2')}"]`)!.getBoundingClientRect().top;
  resolve();
  await until('owner row appears at the reading anchor', () => host.querySelector('[data-item-id="real-item"]') !== null);
  await settle();
  const after = host.querySelector('[data-item-id="real-item"]')!.getBoundingClientRect().top;
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
});
