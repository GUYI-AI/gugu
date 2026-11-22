import { Folder, Globe } from '@/lib/icons';
import { i18n } from '@/i18n';
import { clearViewState, writeViewState } from '@/lib/viewStateTable';
import { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ChatPanes, ChatTabChip } from '@renderer/features/chats/chat-tabs/chat-panes';
import { chatLayoutOf, closeChatTab, panelTabsOf } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { installSessionTabViews } from '@renderer/features/sessions/session-tab-views';
import { BrowserWorkspaceStartContent } from '@renderer/features/browser/browser-workspace-start-page';
import { recentToolPanel, type RecentTool } from '@renderer/features/browser/workspace-recent-tools';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { appState } from '@renderer/lib/stores/app-state';
import '@renderer/index.css';
import '@/styles/tokens.css';

const { navigate, registerBrowser } = vi.hoisted(() => ({ navigate: vi.fn(), registerBrowser: vi.fn(async () => ({ success: false })) }));
vi.mock('@renderer/features/chats/owned-agent-chat-boundary', () => ({
  OwnedAgentChatBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@renderer/lib/ipc', async (original) => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  const fixture = new Proxy(actual.rpc, {
    get(target, key) {
      // A real renderer page with no Electron web contents behind it.
      if (key === 'browser') return {
        registerSession: registerBrowser,
        unregisterSession: async () => ({ success: true }),
        setActiveBrowser: async () => ({ success: true }),
      };
      return Reflect.get(target, key);
    },
  });
  return { ...actual, rpc: fixture };
});
vi.mock('@renderer/lib/layout/navigation-provider', async (original) => ({
  ...(await original<object>()), useNavigate: () => ({ navigate }),
}));

let harness: ReturnType<typeof createReactHarness> | undefined;
const previousTheme = document.documentElement.dataset.theme;
const group = { viewId: 'new-tab-group', place: { kind: 'chat', chatId: 'new-tab-group' } } as const;
const topic = { viewId: 'new-tab-topic', place: { kind: 'chat', chatId: 'new-tab-topic' } } as const;

it('keeps the annotation entry visible on an ordinary group browser and registers the tab conversation', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1240, 640);
  const view = harness = createReactHarness();
  view.container.className = 'emlight gugu-skin';
  view.container.style.cssText = 'position:fixed;inset:0;width:1200px;height:580px';
  const chatId = 'annotation-entry-group';
  installSessionTabViews();
  const layout = chatLayoutOf(chatId);
  try {
    await view.render(<ChatPanes chatId={chatId} actionsSlot={null} body={<div>群聊正文</div>}
      chip={({ tab, host }) => <ChatTabChip tab={tab} host={host} label="批注测试群" menu={null} focused />} />);
    await act(() => { layout.open('browser', { initialUrl: 'https://example.org/group' }, { from: null, intent: 'newTab' }); });
    await expect.element(page.getByRole('button', { name: '批注', exact: true })).toBeVisible();
    // Without an Electron page behind this browser fixture, the visible action waits disabled.
    await expect.element(page.getByRole('button', { name: '批注', exact: true })).toBeDisabled();
    // Registration runs in the pane's effect after the session exists; the disabled action can paint before it fires.
    await until('browser tab registered with its conversation', () => registerBrowser.mock.calls.length, (calls) => calls > 0);
    expect(registerBrowser).toHaveBeenCalledWith(expect.objectContaining({ conversation: { kind: 'chat', chatId } }));
    const toolbar = page.getByRole('button', { name: '批注', exact: true }).element();
    const address = page.getByPlaceholder('搜索或输入网址').element();
    expect(toolbar.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  } finally {
    await act(() => {
      for (const { pane } of layout.groups) for (const tab of [...pane.resolvedTabs]) if (tab.kind !== 'chat') closeChatTab(chatId, tab.tabId);
    });
  }
});
afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
  commandRegistry.setContext(document.body);
  clearViewState(recentToolPanel(group));
  clearViewState(recentToolPanel(topic));
});

it('shows the context tools, opens recent resources, and removes them only from the owning tab list', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1024, 720);
  const view = harness = createReactHarness();
  view.container.className = 'emlight gugu-skin';
  document.documentElement.dataset.theme = 'light';
  view.container.style.cssText = 'width:760px;height:540px';
  const recent: RecentTool[] = [
    { kind: 'chat-file', id: 'chat-file:report', itemId: 'report', title: '行程.md' },
    { kind: 'web', id: 'web:news', url: 'https://example.com/news', title: '公告' },
  ];
  writeViewState(recentToolPanel(group), { items: recent });
  const focusUrl = vi.fn();
  const openUrl = vi.fn();
  const openRecent = vi.fn();
  const openFolder = vi.fn();
  const openApp = vi.fn();
  const render = (ctx: typeof group | typeof topic) => act(() => view.render(
    <BrowserWorkspaceStartContent config={{ ctx, openRecent }}
      actions={[
        { id: 'files', label: '文件', icon: <Folder />, onClick: openFolder },
        { id: 'browser', label: '浏览器', icon: <Globe />, onClick: () => {} },
        { id: 'browser-app', label: '浏览器', icon: <Globe />, section: 'extensions', onClick: openApp },
      ]}
      onOpenUrl={openUrl} onFocusUrl={focusUrl}
    />
  ));
  await render(group);
  await expect.element(page.getByRole('heading', { name: '最近' })).toBeVisible();
  // One row of tiles: built-ins, then Apps, then Add App.
  await userEvent.click(page.getByRole('button', { name: '文件', exact: true }));
  await userEvent.click(page.getByRole('button', { name: '浏览器', exact: true }).nth(0));
  await userEvent.click(page.getByRole('button', { name: '浏览器', exact: true }).nth(1));
  expect(openApp).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole('button', { name: '添加应用', exact: true }));
  // Add App goes to the Apps tab of the Apps page, wherever that page was left.
  expect(appState.navigation.currentViewId).toBe('apps');
  expect(appState.navigation.viewParamsStore.apps?.location).toEqual({ tab: 'market' });
  expect(openFolder).toHaveBeenCalledOnce();
  expect(focusUrl).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole('button', { name: '行程.md', exact: true }));
  await userEvent.click(page.getByRole('button', { name: '公告', exact: true }));
  expect(openRecent).toHaveBeenCalledWith(recent[0]);
  expect(openUrl).toHaveBeenCalledWith('https://example.com/news');
  await act(() => userEvent.click(page.getByRole('button', { name: '从最近打开中移除 行程.md' })));
  await expect.element(page.getByRole('button', { name: '行程.md', exact: true })).not.toBeInTheDocument();
  await render(topic);
  await expect.element(page.getByText('暂无最近打开的项目')).toBeVisible();
  await render(group);
  await expect.element(page.getByRole('button', { name: '公告', exact: true })).toBeVisible();
});

it('opens the actual group tab from the header and reveals explicitly requested new tabs', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1240, 640);
  const view = harness = createReactHarness();
  view.container.className = 'emlight gugu-skin';
  document.documentElement.dataset.theme = 'light';
  view.container.style.cssText = 'position:fixed;inset:0;width:1200px;height:580px';
  installSessionTabViews();
  await act(() => view.render(
    <ChatPanes chatId={group.place.chatId} actionsSlot={null} body={<div>群聊正文</div>}
      chip={({ tab, host }) => <ChatTabChip tab={tab} host={host} label="示例群聊" menu={null} focused />} />,
  ));
  const header = (mode: string) => view.container.querySelector(`[data-chat-workspace-header="${mode}"]`);
  try {
    await expect.poll(() => header('empty')).not.toBeNull();
    await act(() => userEvent.click(page.getByRole('button', { name: '显示标签页' })));
    await expect.poll(() => header('split')).not.toBeNull();
    await expect.element(page.getByPlaceholder('搜索或输入网址')).toBeVisible();
    await expect.element(page.getByRole('heading', { name: '最近' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: '审阅', exact: true })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole('button', { name: '浏览器', exact: true }));
    await expect.element(page.getByPlaceholder('搜索或输入网址')).toHaveFocus();

    await act(() => userEvent.click(page.getByRole('button', { name: '隐藏标签页' })));
    await expect.poll(() => header('hidden')).not.toBeNull();
    await act(() => {
      commandRegistry.setContext(page.getByRole('button', { name: '显示标签页' }).element() as HTMLElement);
      expect(commandRegistry.dispatch('session.openAddMenu')).toBe(true);
    });
    await expect.poll(() => header('split')).not.toBeNull();
    expect(header('split')?.querySelectorAll('[data-tab-label="新标签页"]')).toHaveLength(2);
    await act(() => userEvent.click(page.getByRole('button', { name: '文件', exact: true })));
    expect(panelTabsOf(group.place.chatId)).toHaveLength(1);
    expect(panelTabsOf(group.place.chatId)[0]?.shown).toBe(true);
  } finally {
    const layout = chatLayoutOf(group.place.chatId);
    await act(() => {
      for (const { pane } of layout.groups) {
        for (const entry of pane.resolvedTabs) {
          if (entry.kind !== 'chat') closeChatTab(group.place.chatId, entry.tabId);
        }
      }
    });
  }
});

it('draws the start page in the app theme and the pinned-light web area in light alone', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1240, 640);
  const view = harness = createReactHarness();
  view.container.className = 'emdark gugu-skin';
  document.documentElement.dataset.theme = 'dark';
  view.container.style.cssText = 'position:fixed;inset:0;width:1200px;height:580px';
  installSessionTabViews();
  await act(() => view.render(
    <ChatPanes chatId={group.place.chatId} actionsSlot={null} body={<div>群聊正文</div>}
      chip={({ tab, host }) => <ChatTabChip tab={tab} host={host} label="示例群聊" menu={null} focused />} />,
  ));
  // Relative luminance from a computed `rgb(...)`.
  const luminance = (color: string) => {
    const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map((v) => Number(v) / 255)
      .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  try {
    await act(() => userEvent.click(page.getByRole('button', { name: '显示标签页' })));
    await expect.element(page.getByRole('heading', { name: '最近' })).toBeVisible();
    const start = view.container.querySelector('[data-workspace-new-tab-page]')!;
    const heading = page.getByRole('heading', { name: '最近' }).element();
    const tile = page.getByRole('button', { name: '文件', exact: true }).element();
    expect(luminance(getComputedStyle(start).backgroundColor)).toBeLessThan(0.1);
    expect(luminance(getComputedStyle(heading).color)).toBeGreaterThan(0.8);
    expect(luminance(getComputedStyle(tile).color)).toBeGreaterThan(0.3);

    // The web area pins itself light once the start page steps aside; its colour classes must resolve to that light set.
    const pinned = document.createElement('div');
    pinned.dataset.theme = 'light';
    pinned.className = 'emlight bg-background text-foreground';
    start.append(pinned);
    expect(luminance(getComputedStyle(pinned).backgroundColor)).toBeGreaterThan(0.9);
    expect(luminance(getComputedStyle(pinned).color)).toBeLessThan(0.1);
    pinned.remove();
  } finally {
    const layout = chatLayoutOf(group.place.chatId);
    await act(() => {
      for (const { pane } of layout.groups) {
        for (const entry of pane.resolvedTabs) {
          if (entry.kind !== 'chat') closeChatTab(group.place.chatId, entry.tabId);
        }
      }
    });
  }
});
