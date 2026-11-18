/**
 * #2548 内层侧栏「话题」那一行:真 Chromium 里按住拖到聊天区,落下的是聊天列表话题子行同一份内容(来源对话 + 话题,
 * 话题开成分栏)。jsdom 证不了「浏览器真的发起了原生拖拽」—— 行里那枚按钮吞掉 mousedown 时连 dragstart 都不发。
 */
import { act } from 'react';
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { innerSidebarTopicsSlotKey } from '@/lib/innerSidebarBridge';
import { readShellSlots } from '@/lib/shellSlots';
import { clearDraggedScreenContent, getDraggedScreenContent, SCREEN_CONTENT_DRAG_TYPE } from '@renderer/lib/drag-screen-content';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/store/devicesContext', async (original) => ({ ...(await original<object>()), useDevicesStore: () => ({ devices: [] }) }));
vi.mock('@/hooks/useAgentDisplayStatus', async (original) => ({ ...(await original<object>()), useAgentDisplayStatuses: () => ({}) }));
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }));

const { ChatListSlotHost } = await import('@/components/ChatListSlotHost');

const recent = new Date(Date.now() - 5 * 60_000).toISOString();
const chats = [
  chat({ id: 'grp-1', kind: 'group', name: '产品讨论群', avatar: null, last_message_at: recent }),
  chat({ id: 't-1', kind: 'topic', name: '定价页方案', source_chat_id: 'grp-1', last_message_at: recent, unread_count: 1 }),
];

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(() => {
  act(() => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey('grp-1'), null));
  harness?.cleanup();
  clearDraggedScreenContent();
});

it('drags an inner-column topic row into the chat area with the topic sub-row payload', async () => {
  await page.viewport(1000, 800);
  harness = createReactHarness();
  await renderWithAppProviders(harness, createNode(ChatListSlotHost, {}), { chat: { chats } });
  const slot = document.body.appendChild(document.createElement('div'));
  slot.style.cssText = 'position:fixed;left:0;top:0;width:260px';
  await act(async () => readShellSlots()!.setSlot(innerSidebarTopicsSlotKey('grp-1'), slot));
  await until('the inner topic row rendered', () => slot.querySelector('[data-topic-row="t-1"]') !== null);

  const target = document.createElement('div');
  target.style.cssText = 'position:fixed;left:400px;top:100px;width:200px;height:100px';
  const drops: unknown[] = [];
  target.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer!.dropEffect = 'move'; });
  target.addEventListener('drop', (event) => {
    event.preventDefault();
    drops.push({ trusted: event.isTrusted, types: [...event.dataTransfer!.types], content: getDraggedScreenContent(event.dataTransfer!) });
  });
  document.body.appendChild(target);
  try {
    await userEvent.dragAndDrop(slot.querySelector<HTMLElement>('[data-topic-row="t-1"]')!, target);
    expect(drops).toEqual([{
      trusted: true,
      types: [SCREEN_CONTENT_DRAG_TYPE],
      content: { kind: 'chat', chatId: 'grp-1', title: '定价页方案', topic: { chatId: 't-1', name: '定价页方案' } },
    }]);
  } finally {
    target.remove();
    slot.remove();
  }
});
