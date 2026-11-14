/**
 * #2548 a new project's row in the one list. The owner's recording (11-13): after 新建空白项目 the project's row was drawn
 * after every conversation, and ~200 ms later, when its group reached the chat list, it jumped to the top. Now the chat
 * list (the shell's root) leaves a place among its conversation rows at the project's time and the task page (another
 * React root) draws the row into it. This pins, in a real browser, that the row is in that place before the next frame
 * is painted, and that when the group's conversation arrives its row is in that same place in the same commit.
 */
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { runInAction } from 'mobx';
import { act, useSyncExternalStore } from 'react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import { installShellSlots, readShellSlots } from '@/lib/shellSlots';
import { ONE_LIST_PROJECT_SLOT_PREFIX, publishSidebarChatView } from '@/lib/sidebarChatsBridge';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/store/devicesContext', async (original) => ({ ...(await original<object>()), useDevicesStore: () => ({ devices: [] }) }));
vi.mock('@/hooks/useAgentDisplayStatus', async (original) => ({ ...(await original<object>()), useAgentDisplayStatuses: () => ({}) }));
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }));

const { ChatListPanel } = await import('@/components/ChatListPanel');

/** The task page's side, as sidebar-one-list draws it: a row in each place the chat list left. */
installShellSlots();
const slots = readShellSlots()!;
function TaskPageRows() {
  const all = useSyncExternalStore(slots.subscribeSlots, slots.getSlots);
  const places = [...all].flatMap(([key, element]) => (key.startsWith(ONE_LIST_PROJECT_SLOT_PREFIX) ? [[key.slice(ONE_LIST_PROJECT_SLOT_PREFIX.length), element] as const] : []));
  // Not the list's 58px first guess for a line: the line must be measured once the row is drawn, not guessed.
  return [...places].map(([chatId, element]) => createPortal(<div data-drawn={chatId} style={{ height: 64 }}>{chatId}</div>, element, chatId));
}

const at = (minute: number) => new Date(Date.UTC(2099, 0, 1, 0, minute)).toISOString();
const chats = [
  chat({ id: 'room', kind: 'group', name: 'Room', avatar: null, member_user_ids: ['me'], last_message_at: at(30) }),
  chat({ id: 'older', kind: 'group', name: 'Older', avatar: null, member_user_ids: ['me'], last_message_at: at(10) }),
];
const created = at(40);

let harness: ReturnType<typeof createReactHarness>;
let taskPage: Root | null = null;
let taskPageHost: HTMLDivElement | null = null;
beforeAll(async () => { await i18n.changeLanguage('en-US'); });
afterEach(() => {
  act(() => taskPage?.unmount());
  taskPageHost?.remove();
  harness?.cleanup();
  accountProjectsStore.clear();
  publishSidebarChatView({ focusedChatId: null, groups: [] });
});

const render = (list: typeof chats) =>
  renderWithAppProviders(harness, createNode(ChatListPanel, { activeTab: 'chats', mobile: false, placement: 'sidebar' }), { chat: { chats: list, activeChatId: null } });
/** The list's lines top to bottom: a conversation row, or the task page's row in the place left for it. */
const lines = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row], [data-drawn]')].map((line) => line.dataset.chatRow ?? `drawn:${line.dataset.drawn}`);
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
/** Where each mounted line sits: every line starts where the one above it ends (no overlap, no gap). */
const gaps = () => {
  const placed = [...harness.container.querySelectorAll<HTMLElement>('[data-index]')]
    .map((line) => ({ index: Number(line.dataset.index), box: line.getBoundingClientRect() }))
    .sort((a, b) => a.index - b.index);
  return placed.slice(1).map((line, i) => Math.round(line.box.top - placed[i]!.box.bottom));
};

it('the new project\'s row is in its place before the next frame, and its conversation row takes that place', async () => {
  await page.viewport(1000, 800);
  harness = createReactHarness();
  harness.container.style.cssText = 'width: 320px; height: 600px; overflow-y: auto;';
  publishSidebarChatView({ focusedChatId: null, groups: [], oneList: true });
  runInAction(() => { accountProjectsStore.status = 'ready'; });
  await render(chats);
  await until('the conversation rows rendered', () => lines().join() === 'room,older');
  taskPageHost = document.createElement('div');
  document.body.append(taskPageHost);
  taskPage = createRoot(taskPageHost);
  act(() => taskPage!.render(<TaskPageRows />));

  // The account project list learns of the new project (its group's conversation is not in the chat list yet). Outside
  // act, as in the app: React schedules both roots' renders itself, and what the next frame shows is what a person sees.
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = false;
  let seenAtFrame: string[] = [];
  let gapsAtFrame: number[] = [];
  try {
    const frame = nextFrame().then(() => { seenAtFrame = lines(); gapsAtFrame = gaps(); });
    runInAction(() => { accountProjectsStore.list = [{ chatId: 'blink', name: 'Blink', archived: false, activeAt: created, bindings: [] }]; });
    await frame;
  } finally {
    environment.IS_REACT_ACT_ENVIRONMENT = true;
  }
  expect(seenAtFrame, 'drawn in its place by the first frame after the list learnt of it').toEqual(['drawn:blink', 'room', 'older']);
  expect(gapsAtFrame, 'and the rows below it already make room for it in that frame').toEqual([0, 0]);

  // Its group reaches the chat list (created when the project was, no message yet).
  await render([...chats, chat({ id: 'blink', kind: 'group', name: 'Blink', avatar: null, member_user_ids: ['me'], created_at: created })]);
  expect(lines()).toEqual(['blink', 'room', 'older']);
  expect(gaps(), 'the conversation row is measured as it arrives').toEqual([0, 0]);
  expect(document.querySelector('[data-drawn]'), 'the task page\'s row went with its place').toBeNull();
  const row = harness.container.querySelector<HTMLElement>('[data-chat-row="blink"]')!;
  expect(row.getBoundingClientRect().top, 'the conversation row is where the project row was: the top line').toBeLessThan(
    harness.container.querySelector<HTMLElement>('[data-chat-row="room"]')!.getBoundingClientRect().top,
  );
});
