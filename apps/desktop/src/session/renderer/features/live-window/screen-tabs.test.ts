import { expect, it, vi } from 'vitest';
import { LiveWindowModel } from './model';
import type { LiveWindowConversation } from './conversation';
const conversation: { model?: LiveWindowModel } = {};
const view: { paneLayout?: unknown } = {};
vi.mock('../sessions/stores/session-selectors', () => ({ getSessionView: () => view }));
vi.mock('./use-live-window-conversation', () => ({ findLiveWindowConversation: () => conversation as LiveWindowConversation }));
vi.mock('../tabs/tab-bar/generic-tab-item', () => ({ GenericTabItem: () => null, GenericTabDragPreview: () => null }));
import { liveWindowTabProvider } from './live-window-tab';
import { screenTabsOf, syncScreenTabs } from './screen-tabs';
import { createTabProvider, createTabRegistry } from '../tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '../tabs/pane-layout-store';

const session = createTabProvider({ kind: 'session', conversation: true, resourceKey: (state: { id: string }) => state.id,
  initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });

it('keeps one screen tab per source in the side pane of a chat workspace, and X closes one for good', async () => {
  const model = new LiveWindowModel('desktop'); conversation.model = model;
  const context = { conversationId: 's', sessionId: 's', deviceId: 'd', agentId: 'a', privateAgentChat: true, shown: true };
  const source = (id: string, kind: 'browser' | 'computer', activity: number) =>
    ({ ...context, id, kind, title: id, activity, size: { width: 800, height: 600 }, status: 'operating' as const });
  model.activate(context);
  model.observe(context, [source('web', 'browser', 1), source('pc', 'computer', 1)]);
  model.dispatch({ type: 'show-tab' });
  const layout = new PaneLayoutStore(createTabRegistry([session, liveWindowTabProvider as never]), { viewId: 'v' }, undefined, {
    isPrimaryChatTab: entry => entry.kind === 'session', placementMemory: { read: () => undefined, write() {} } });
  view.paneLayout = layout;
  const chatTabId = layout.open('session', { id: 's' }, { from: null, intent: 'newTab' })!;
  const detach = layout.attachChatWorkspace();
  const chat = { pane: layout.groups.find(group => group.pane.entries.has(chatTabId))!.pane, tabId: chatTabId };
  const sync = () => { const snapshot = model.getSnapshot(); syncScreenTabs(layout, chat, 'k', snapshot.presentation, snapshot.sources); };
  const tabs = () => screenTabsOf(layout, 'k').map(({ sourceId, holder }) => `${holder === chat.pane ? 'chat' : 'side'}:${sourceId}`).sort();
  try {
    sync();
    expect(tabs()).toEqual(['side:pc', 'side:web']);
    // Every agent step bumps a source's activity; that is not a new source.
    model.observe(context, [source('web', 'browser', 2), source('pc', 'computer', 1)]); sync(); sync();
    expect(tabs()).toEqual(['side:pc', 'side:web']);
    const web = screenTabsOf(layout, 'k').find(({ sourceId }) => sourceId === 'web')!;
    web.holder.requestCloseTab(web.tab.tabId);
    await Promise.resolve(); sync();
    expect(tabs()).toEqual(['side:pc']);
    model.observe(context, [source('web', 'browser', 3), source('pc', 'computer', 2)]); sync();
    expect(tabs()).toEqual(['side:pc']);
    const pc = screenTabsOf(layout, 'k')[0]!;
    pc.holder.requestCloseTab(pc.tab.tabId);
    await Promise.resolve(); sync();
    expect(tabs()).toEqual([]);
    model.observe(context, [source('web', 'browser', 4), source('pc', 'computer', 3)]); sync();
    expect(tabs()).toEqual([]);
  } finally { detach(); layout.dispose(); }
});
