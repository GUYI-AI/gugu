import { act, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { PaneContext } from '../../features/tabs/pane-context';
import { PaneLayoutStore } from '../../features/tabs/pane-layout-store';
import { createTabProvider, createTabRegistry } from '../../features/tabs/core/tab-provider-registry';
import { activeChatSessionId } from '../../features/sessions/view/session-pane-policy';
import { DesktopLiveWindowHeader } from '../../features/live-window/DesktopLiveWindowHeader';
import { LiveWindowModel } from '../../features/live-window/model';

const state = vi.hoisted(() => ({ model: null as unknown as LiveWindowModel, bound: true }));
vi.mock('../../features/sessions/stores/session-agent-bindings', () => ({
  sessionAgentBindings: { bindingFor: () => state.bound ? { agentUserId: 'agent' } : undefined },
}));
vi.mock('../../features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { connectionState: () => 'connected' } }));
vi.mock('../../features/live-window/desktop-transport', () => ({ desktopLiveWindowTransport: () => ({}) }));
vi.mock('../../features/live-window/desktop-context', () => ({ bindDesktopLiveWindowActivity: () => {} }));
vi.mock('../../features/live-window/use-live-window-conversation', () => ({
  useLiveWindowConversation: () => ({
    ...useSyncExternalStore(state.model.subscribe, state.model.getSnapshot),
    conversation: state.model,
    dispatch: state.model.dispatch.bind(state.model),
  }),
}));

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
beforeEach(() => {
  state.bound = true;
  state.model = new LiveWindowModel('desktop');
  const context = { conversationId: 'task', deviceId: 'local', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true };
  state.model.activate(context);
  state.model.observe(context, [{ id: 'browser', kind: 'browser', status: 'operating', activity: 1,
    deviceId: 'local', sessionId: 'task', agentId: 'agent', title: 'Browser', size: { width: 1280, height: 900 } }]);
});

function createLayout(kind: 'session' | 'acp-chat') {
  const provider = (kind: string) => createTabProvider({
    kind, resourceKey: (state: { id?: string; sessionId?: string }) => state.id ?? state.sessionId ?? '',
    initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null,
  });
  const layout = new PaneLayoutStore(createTabRegistry([provider('file'), provider(kind)]), { viewId: 'view' });
  layout.setDimensions(1280, 800);
  const file = layout.open('file', { id: 'file' }, { from: null, intent: 'newTab' })!;
  const chat = layout.open(kind, { sessionId: 'task' }, { from: null, intent: 'newTab' })!;
  cleanups.push(() => layout.dispose());
  return { layout, file, chat };
}

async function mount(layout: PaneLayoutStore, detached = false) {
  await page.viewport(1280, 800);
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host), group = detached ? layout.sideGroup! : layout.mainGroup;
  await act(async () => root.render(<PaneContext.Provider value={{ ...group, isFocusedPane: false }}>
    <DesktopLiveWindowHeader projectId="project" sessionId={activeChatSessionId(layout as never)} {...(detached ? {} : { paneLayout: layout })} />
  </PaneContext.Provider>));
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  return host;
}

describe.each(['session', 'acp-chat'] as const)('%s private-chat header across paired panes', kind => {
  it('can reopen a hidden picture with a file in the main pane and the private chat beside it', async () => {
    const { layout, file, chat } = createLayout(kind);
    layout.pairWith(file, chat, { focus: false });
    expect(layout.mainGroup.pane.activeEntry?.kind).toBe('file');
    expect(layout.sideGroup?.pane.activeEntry?.kind).toBe(kind);
    expect(activeChatSessionId(layout as never)).toBe('task');
    state.model.dispatch({ type: 'toggle-window' });
    const host = await mount(layout);
    const toggle = host.querySelector<HTMLButtonElement>('[data-live-window-toggle]');
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute('aria-pressed')).toBe('false');
    await page.elementLocator(toggle!).click();
    expect(state.model.getSnapshot().visible).toBe(true);
    expect(toggle!.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps the existing main-chat path working with a file beside it', async () => {
    const { layout, file, chat } = createLayout(kind);
    layout.pairWith(chat, file);
    const host = await mount(layout);
    expect(host.querySelector('[data-live-window-toggle]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not expose a retained chat hidden behind the file or a narrow layout', async () => {
    const { layout, file, chat } = createLayout(kind);
    layout.mainGroup.pane.setActiveTab(file);
    const host = await mount(layout);
    expect(host.querySelector('[data-live-window-toggle]')).toBeNull();
    await act(async () => { layout.pairWith(file, chat); layout.setActiveGroup(layout.mainGroup.paneId); layout.setSinglePaneHost(true); });
    expect(host.querySelector('[data-live-window-toggle]')).toBeNull();
    await act(async () => layout.setActiveGroup(layout.sideGroup!.paneId));
    expect(host.querySelector('[data-live-window-toggle]')).not.toBeNull();
  });
});

it('retains the pane-local header scope for a detached private-chat window', async () => {
  const { layout, file, chat } = createLayout('acp-chat');
  layout.pairWith(file, chat);
  const host = await mount(layout, true);
  expect(host.querySelector('[data-live-window-toggle]')).not.toBeNull();
});

it('requires an Agent binding even when the private-chat tab is visible', async () => {
  const { layout, file, chat } = createLayout('acp-chat');
  layout.pairWith(file, chat);
  state.bound = false;
  const host = await mount(layout);
  expect(host.querySelector('[data-live-window-toggle]')).toBeNull();
});
