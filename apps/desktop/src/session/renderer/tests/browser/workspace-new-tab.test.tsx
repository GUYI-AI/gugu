import { Folder, Globe } from '@/lib/icons';
import { i18n } from '@/i18n';
import { clearViewState, writeViewState } from '@/lib/viewStateTable';
import { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { ChatPanes, ChatTabChip } from '@renderer/features/chats/chat-tabs/chat-panes';
import { chatLayoutOf, closeChatTab, panelTabsOf } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { installSessionTabViews } from '@renderer/features/sessions/session-tab-views';
import { BrowserWorkspaceStartContent } from '@renderer/features/browser/browser-workspace-start-page';
import { recentToolPanel, type RecentTool } from '@renderer/features/browser/workspace-recent-tools';
import { commandRegistry } from '@renderer/lib/commands/registry';
import '@renderer/index.css';
import '@/styles/tokens.css';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@renderer/features/chats/owned-agent-chat-boundary', () => ({
  OwnedAgentChatBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@renderer/lib/ipc', async (original) => {
  const actual = await original<typeof import('@renderer/lib/ipc')>();
  const fixture = new Proxy(actual.rpc, {
    get(target, key) {
      // A real renderer page with no Electron web contents behind it.
      if (key === 'browser') return {
        registerSession: async () => ({ success: false }),
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
  await expect.element(page.getByRole('heading', { name: '内置' })).toBeVisible();
  await expect.element(page.getByRole('heading', { name: '最近' })).toBeVisible();
  const builtins = page.getByRole('region', { name: '内置', exact: true });
  const apps = page.getByRole('region', { name: '应用', exact: true });
  await expect.element(apps.getByRole('button', { name: '添加应用', exact: true })).toBeVisible();
  await expect.element(builtins.getByRole('button', { name: '添加应用', exact: true })).not.toBeInTheDocument();
  await userEvent.click(builtins.getByRole('button', { name: '文件', exact: true }));
  await userEvent.click(builtins.getByRole('button', { name: '浏览器', exact: true }));
  await userEvent.click(apps.getByRole('button', { name: '浏览器', exact: true }));
  expect(openApp).toHaveBeenCalledOnce();
  await userEvent.click(apps.getByRole('button', { name: '添加应用', exact: true }));
  expect(navigate).toHaveBeenCalledWith('apps');
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

it('opens the actual group tab from the header and keeps newly opened tabs hidden until restored', async () => {
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
    await expect.element(page.getByRole('heading', { name: '内置' })).toBeVisible();
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
    await expect.poll(() => header('hidden')).not.toBeNull();
    await act(() => userEvent.click(page.getByRole('button', { name: '显示标签页' })));
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
