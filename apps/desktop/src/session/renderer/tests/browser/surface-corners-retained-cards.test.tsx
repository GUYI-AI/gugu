import { DndContext } from '@dnd-kit/core';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { PaneLayoutProvider } from '@renderer/features/tabs/pane-layout-context';
import { RetainedTabContent } from '@renderer/features/tabs/retained-tab-content';
import { GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import '@renderer/index.css';
import '@/styles/tokens.css';
import '@/styles/desktop-shell.css';

/**
 * The content surface is rounded unless the chat workspace on screen shows its tools as cards (then the cards are). A page
 * kept mounted but hidden (a task left with its tools open) must not count: it made the surface around the chat on screen
 * square and transparent (yangchichi 11-24, 「我现在就是直角」).
 */

const provider = (kind: string) => createTabProvider({
  kind,
  conversation: kind === 'conversation',
  resourceKey: (state: { id: string }) => state.id,
  initialize: () => ({ dispose() {} }),
  dispose() {},
  TabContent: () => <div>{kind}</div>,
  TabBarItem: ({ tab, host, ctx }) => <GenericTabItem tab={tab} host={host} ctx={ctx} label={kind} />,
});

let harness: ReturnType<typeof createReactHarness> | undefined;
const stores: PaneLayoutStore[] = [];
afterEach(() => { harness?.cleanup(); harness = undefined; for (const store of stores.splice(0)) store.dispose(); });

function workspace(viewId: string): PaneLayoutStore {
  const store = new PaneLayoutStore(createTabRegistry(['conversation', 'tool'].map(provider)), { viewId }, undefined, {
    isPrimaryChatTab: (entry) => entry.kind === 'conversation',
    placementMemory: { read: () => undefined, write() {} },
  });
  store.open('conversation', { id: viewId }, { from: null, intent: 'newTab' });
  store.setViewActive(true);
  stores.push(store);
  return store;
}

function Tree({ layout }: { layout: PaneLayoutStore }) {
  return <PaneLayoutProvider paneLayout={layout}><DndContext>
    <PaneTreeView layout={layout} chatChrome={{ actions: null, addTab: null }} renderPane={(paneId, _first, _last, part) => {
      const group = layout.groups.find((pane) => pane.paneId === paneId)!;
      return <PaneProvider group={group} isFocusedPane><PaneContent part={part} /></PaneProvider>;
    }} />
  </DndContext></PaneLayoutProvider>;
}

it('a hidden page with its tools as cards leaves the surface around the chat on screen rounded', async () => {
  await page.viewport(1400, 800);
  const task = workspace('task');
  const chat = workspace('chat');
  const view = harness = createReactHarness();
  view.container.classList.add('emlight', 'gugu-skin');
  view.container.style.cssText = 'position:fixed;inset:0;display:flex';
  const draw = (taskShown: boolean) => view.render(
    <div data-workspace-content-surface="" style={{ position: 'relative', flex: 1, display: 'flex' }}>
      <RetainedTabContent visible={taskShown} style={{ position: 'absolute', inset: 0 }}><Tree layout={task} /></RetainedTabContent>
      <RetainedTabContent visible={!taskShown} style={{ position: 'absolute', inset: 0 }}><Tree layout={chat} /></RetainedTabContent>
    </div>,
  );
  const surface = () => getComputedStyle(view.container.querySelector('[data-workspace-content-surface]')!);
  // The task on screen with a tool beside it: its tools are cards, the surface gives way to them (the positive control).
  await act(() => draw(true));
  act(() => task.open('tool', { id: 'file' }, { from: null, intent: 'newTab' }));
  await until('the task shows its tools as cards', () => !!view.container.querySelector('[data-chat-tool-cards]'));
  expect(surface().borderTopLeftRadius).toBe('0px');
  // Left with its tools open (still mounted, hidden): the chat on screen has no tools beside it.
  await act(() => draw(false));
  expect(view.container.querySelector('[data-chat-tool-cards]'), 'the hidden task keeps its cards').not.toBeNull();
  await until('the surface is rounded again', () => surface().borderTopLeftRadius === '12px');
  expect(surface().backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
});
