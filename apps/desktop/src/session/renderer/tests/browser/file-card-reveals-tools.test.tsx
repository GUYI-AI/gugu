import { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { i18n } from '@/i18n';
import { FileAttachmentCard } from '@/components/chat/FileAttachmentCard';
import { ChatPanes, ChatTabChip } from '@renderer/features/chats/chat-tabs/chat-panes';
import { chatLayoutOf, closeChatTab, openPanelItem, panelTabsOf } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { folderItem, type PanelItem } from '@renderer/features/chats/chat-tabs/chat-panel-item';
import { commandRegistry } from '@renderer/lib/commands/registry';
import '@renderer/index.css';
import '@/styles/tokens.css';

vi.mock('@renderer/features/chats/owned-agent-chat-boundary', () => ({
  OwnedAgentChatBoundary: ({ children }: { children: ReactNode }) => children,
}));
// The resolved file is handed to the same layout boundary as useChatOpener.
// File-host metadata is outside this visibility test; the actual card and panes render.
vi.mock('@/lib/fileHost', async (original) => ({
  ...(await original<object>()), useFileHost: () => null,
}));

let harness: ReturnType<typeof createReactHarness> | undefined;
const chatId = 'file-card-reveal-group';
const item: PanelItem = { kind: null, itemId: 'file-card-html', title: '验收.html', fileName: '验收.html' };
const previousTheme = document.documentElement.dataset.theme;
afterEach(() => {
  harness?.cleanup(); harness = undefined;
  const layout = chatLayoutOf(chatId);
  for (const { pane } of layout.groups) {
    for (const tab of [...pane.resolvedTabs]) if (tab.kind !== 'chat') closeChatTab(chatId, tab.tabId);
  }
  commandRegistry.setContext(document.body);
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

it('reveals the tools and selects the file tab when a collapsed conversation opens a file card', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1240, 700);
  const view = harness = createReactHarness();
  view.container.className = 'emlight gugu-skin';
  view.container.style.cssText = 'position:fixed;inset:0;width:1200px;height:620px';
  document.documentElement.dataset.theme = 'light';
  await act(() => view.render(
    <ChatPanes chatId={chatId} actionsSlot={null}
      body={<FileAttachmentCard file={{ fileName: '验收.html', mimeType: 'text/html', sizeBytes: 2575127 }}
        onOpen={() => { openPanelItem(chatId, item); }} />}
      chip={({ tab, host }) => <ChatTabChip tab={tab} host={host} label="文件测试群" menu={null} focused />} />,
  ));
  const layout = chatLayoutOf(chatId);
  const header = (mode: string) => view.container.querySelector(`[data-chat-workspace-header="${mode}"]`);
  await expect.poll(() => header('empty')).not.toBeNull();
  await act(() => { openPanelItem(chatId, folderItem()); });
  await expect.poll(() => header('split')).not.toBeNull();
  const geometry = [...layout.paneSizes];

  for (let opening = 0; opening < 2; opening++) {
    await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
    await expect.poll(() => header('hidden')).not.toBeNull();
    await userEvent.click(page.getByRole('button', { name: '验收.html', exact: true }));
    await expect.poll(() => header('split')).not.toBeNull();
    const tab = panelTabsOf(chatId).find((candidate) => candidate.item.itemId === item.itemId)!;
    expect(tab.shown).toBe(true);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(tab.tabId);
    expect(layout.paneSizes).toEqual(geometry);
    expect(panelTabsOf(chatId).filter((candidate) => candidate.item.itemId === item.itemId)).toHaveLength(1);
    await expect.poll(() => view.container.querySelector<HTMLElement>('[data-panel-tab="preview"] [data-tab-label="验收.html"]')
      ?.checkVisibility({ visibilityProperty: true })).toBe(true);
  }
});
