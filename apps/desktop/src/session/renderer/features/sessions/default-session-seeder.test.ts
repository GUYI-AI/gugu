import { observable, runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneLayoutStore } from '../tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '../tabs/core/tab-provider-registry';

const known = observable.map<string, { data: { runtime: string } }>();
vi.mock('./stores/session-registry', () => ({ sessionRegistry: { get: () => ({ sessions: known }) } }));
import { DefaultSessionSeeder } from './default-session-seeder';

const provider = (kind: string, conversation = false) => createTabProvider({
  kind, conversation, resourceKey: (s: { sessionId?: string }) => s.sessionId ?? kind, initialize: () => ({ dispose() {} }), dispose() {},
  TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null,
});
let layout: PaneLayoutStore<any> | null = null;
let seeder: DefaultSessionSeeder | null = null;
afterEach(() => { seeder?.dispose(); layout?.dispose(); seeder = null; layout = null; runInAction(() => known.clear()); });
const start = () => {
  layout = new PaneLayoutStore(createTabRegistry([provider('acp-chat', true), provider('computer-use.preview')]), { viewId: 'task' });
  seeder = new DefaultSessionSeeder('task', layout);
  return layout;
};
const kinds = () => layout!.groups.flatMap(({ pane }) => [...pane.entries.values()].map((entry) => entry.kind));

it('opens the conversation of a fresh task', () => {
  runInAction(() => known.set('task', { data: { runtime: 'acp' } }));
  start();
  seeder!.start();
  expect(kinds()).toEqual(['acp-chat']);
});

it('keeps the conversation when an App page arrives before the task is known here', () => {
  const layout = start();
  seeder!.start();
  // A task on another computer pushes its App page while this window has not heard of the task yet.
  const page = layout.open('computer-use.preview', {}, { from: null, intent: 'beside', activate: false })!;
  runInAction(() => known.set('task', { data: { runtime: 'acp' } }));
  expect(kinds().sort()).toEqual(['acp-chat', 'computer-use.preview']);
  const chat = layout.groups.flatMap(({ pane }) => [...pane.entries.values()]).find((entry) => entry.kind === 'acp-chat')!;
  expect(layout.pair).toEqual({ pinned: chat.tabId, side: page });
});

it('leaves restored tabs as they were', () => {
  const layout = start();
  layout.open('computer-use.preview', {}, { from: null, intent: 'newTab' });
  seeder!.markConsumed(true);
  seeder!.start();
  runInAction(() => known.set('task', { data: { runtime: 'acp' } }));
  expect(kinds()).toEqual(['computer-use.preview']);
});
