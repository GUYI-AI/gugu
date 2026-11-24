import { act, useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat';
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key',
}));
vi.mock('@/lib/chat', () => import('../../../../../../../tests/support/contactsChatServiceTestDouble'));

const { ChatHeaderActions } = await import('@/components/chat/ChatHeaderActions');
const groupId = 'toolbar-group';
const collaboration: GroupCollabSnapshot = {
  scheduler: { chat_id: groupId, paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-11-18T00:00:00Z' },
  humans: ['one', 'two', 'three'].map((id) => ({ id, role: 'member', type: 'human', account_status: null })),
  agents: [],
  tasks: [],
};

let harness: ReturnType<typeof createReactHarness> | undefined;
afterEach(() => { harness?.cleanup(); harness = undefined; });

function HeaderFixture({ openMembers }: { openMembers: (page?: 'main' | 'members') => void }) {
  const [menu, setMenu] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  return <div data-chat-workspace-header="split" className="flex" style={{ width: 760 }}>
    <div data-chat-workspace-chat-header="" className="flex h-full min-w-0 items-center px-2" style={{ width: 460 }}>
      <span className="min-w-0 flex-1 truncate">周末去杭州</span>
      <ChatHeaderActions isGroupChat isRoomChat infoShown={false} showHeaderMenu={menu} moreButtonRef={more}
        room={{ snapshot: collaboration, settings: null, onReload: async () => {} }}
        onSearch={() => {}} onOpenFolder={() => {}} onOpenInfo={openMembers} onCloseInfo={() => {}}
        onToggleHeaderMenu={() => setMenu(true)} onCloseHeaderMenu={() => setMenu(false)} />
    </div>
  </div>;
}

it('keeps group actions in reach as the chat column crosses both header widths', async () => {
  await page.viewport(900, 630);
  await i18n.changeLanguage('zh-CN');
  const view = harness = createReactHarness();
  view.container.className = 'emlight gugu-skin';
  const openInfo = vi.fn();
  await renderWithAppProviders(view, <HeaderFixture openMembers={openInfo} />, {
    chat: { activeChatId: groupId, chats: [chat({ id: groupId, kind: 'group', name: '周末去杭州' })] },
  });
  const groupHeader = view.container.querySelector<HTMLElement>('[data-chat-workspace-chat-header]')!;
  const hasText = (id: string, text: string) => groupHeader.querySelector(`[data-testid="${id}"]`)?.textContent?.includes(text);
  const resize = (width: number) => act(() => { groupHeader.style.width = `${width}px`; });
  const { groupMenuTopics, chatHeaderAppsButton, chatHeaderMembersButton, chatHeaderMoreButton } = AUTOMATION_TEST_IDS;

  await until('both group labels are shown above 400 px', () => hasText(groupMenuTopics, '话题') === true && hasText(chatHeaderAppsButton, '应用') === true);
  await resize(324);
  await until('fold the labels and keep the two icon buttons at the default width', () =>
    hasText(groupMenuTopics, '话题') === false && hasText(chatHeaderAppsButton, '应用') === false);
  expect(hasText(chatHeaderMembersButton, '3')).toBe(true);
  await userEvent.click(page.getByTestId(chatHeaderMoreButton));
  expect(page.getByRole('menuitem', { name: /成员列表.*3/ }).query()).toBeNull();
  await userEvent.keyboard('{Escape}');

  await resize(240);
  await until('only the ellipsis remains beside the title below 300 px', () => groupHeader.querySelectorAll('button').length === 1);
  await userEvent.click(page.getByTestId(chatHeaderMoreButton));
  await expect.element(page.getByRole('menuitem', { name: '话题' })).toBeVisible();
  await expect.element(page.getByRole('menuitem', { name: '应用' })).toBeVisible();
  await expect.element(page.getByRole('menuitem', { name: /搜索聊天记录/ })).toBeVisible();
  await userEvent.click(page.getByRole('menuitem', { name: /成员列表.*3/ }));
  expect(openInfo).toHaveBeenCalledWith('members');

  await resize(456);
  await until('wide actions return when the divider moves back', () => hasText(groupMenuTopics, '话题') === true && hasText(chatHeaderAppsButton, '应用') === true);
});
