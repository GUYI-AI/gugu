/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { createChatContext } from '../chat-context';
import { createChatView } from '../chat-view';
import { createChatState } from '../state/chat-state';
import type { TranscriptTurn } from '../model';
import type { ChatCommands } from '../commands';
import type { ViewportProtection } from '../core/viewport-protection';
import { fragmentAnchor } from '../state/source-fragments';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
async function mountSource(options: { beforeLive?: true; compact?: true; count?: number; onViewportProtection?: ChatCommands['onViewportProtection'] } = {}) {
  const context = createChatContext({ locale: () => 'en-US' });
  const state = createChatState(context);
  const fragments = Array.from({ length: options.count ?? (options.compact ? 2 : 7) }, (_, i) => ({ key: `record-${i}`,
    sourceRange: { start: i * 1000, end: i * 1000 + 999 }, ownership: 'unresolved' as const,
    text: options.compact ? `Persisted history ${i}` : `Record ${i}\n\n${'Bounded source body.\n\n'.repeat(18)}` }));
  const sourceWindow = { sourceLineage: 'source', sourceFragments: fragments, beforeLive: options.beforeLive };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:400px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { sourceWindow, onViewportProtection: options.onViewportProtection } });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  await until('source body is actually rendered', () => host.querySelector('[data-source-fragment]') !== null);
  const scroller = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const settle = () => untilStable('source row geometry settles', () => [scroller.scrollTop, scroller.scrollHeight]);
  const resolve = () => {
    state.transcript.history.seed([{ id: 'real-turn', seq: 0, initiator: 'agent', items: [
      { kind: 'message', id: 'real-item', seq: 0, role: 'assistant', text: fragments[2].text },
    ] } satisfies TranscriptTurn]);
    view.setCommands({ onViewportProtection: options.onViewportProtection, sourceWindow: { ...sourceWindow,
      resolvedFragmentOwners: [{ fragmentKey: fragments[2].key, turnId: 'real-turn', itemId: 'real-item' }],
    } });
  };
  return { host, view, scroller, settle, resolve, state, sourceWindow };
}

it('reports mounted source rows and protects the reading anchor while offscreen rows leave residency', async () => {
  const reports: ViewportProtection[] = [];
  const onViewportProtection = (report: ViewportProtection) => { reports.push(report); };
  // Exceed the engine's row-count overscan on both sides of the reading anchor.
  const { host, view, settle, sourceWindow } = await mountSource({ count: 48, onViewportProtection });
  const itemId = fragmentAnchor('record-24');
  view.setScrollMode({ kind: 'anchor', itemId, edge: 'top', offset: 24 });
  await settle();
  await until('the actual engine reports its reading protection', () => reports.at(-1)?.anchor.kind === 'anchor'
    && reports.at(-1)?.itemIds.includes(itemId) === true);
  expect(reports.at(-1)!.anchor).toMatchObject({ kind: 'anchor', itemId });
  const protectedIds = new Set(reports.at(-1)!.itemIds);
  const mounted = [...host.querySelectorAll('[data-source-fragment]')];
  expect(mounted.every(row => protectedIds.has(fragmentAnchor(row.getAttribute('data-source-fragment')!)))).toBe(true);
  const resident = sourceWindow.sourceFragments.filter(row => protectedIds.has(fragmentAnchor(row.key)));
  expect(resident.length).toBeLessThan(sourceWindow.sourceFragments.length);
  expect(resident.some(row => row.key === 'record-0')).toBe(false);
  const before = host.querySelector(`[data-item-id="${itemId}"]`)!.getBoundingClientRect().top;
  view.setCommands({ onViewportProtection, sourceWindow: { ...sourceWindow, sourceFragments: resident } });
  await settle();
  const reading = host.querySelector(`[data-item-id="${itemId}"]`)!;
  expect(reading.textContent).toContain('Bounded source body.');
  expect(Math.abs(reading.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
});

it('keeps fixed opening history above a live reply through its commit, without duplicating the reply', async () => {
  const { host, state, settle } = await mountSource({ beforeLive: true, compact: true });
  const turn = { id: 'new-live-turn', seq: 0, initiator: 'agent', items: [
    { kind: 'message', id: 'new-live-item', seq: 0, role: 'assistant', text: 'A new live-only reply' },
  ] } satisfies TranscriptTurn;
  state.transcript.activeTurn.set(turn);
  await until('live reply is painted after persisted history', () => host.querySelector('[data-item-id="new-live-item"]') !== null);
  await settle();
  state.transcript.history.seed([turn]);
  await settle();
  const history = host.querySelector('[data-source-fragment="record-1"]')!;
  const live = host.querySelector('[data-item-id="new-live-item"]')!;
  expect(history.textContent).toContain('Persisted history 1');
  expect(live.textContent).toContain('A new live-only reply');
  expect(history.getBoundingClientRect().bottom).toBeLessThanOrEqual(live.getBoundingClientRect().top);
  expect(host.querySelectorAll('[data-item-id="new-live-item"]')).toHaveLength(1);
});

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
