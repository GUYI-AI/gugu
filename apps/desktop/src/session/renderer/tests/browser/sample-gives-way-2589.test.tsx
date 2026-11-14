/**
 * #2589 发出示例里的第一句,示例变成项目:示例那一行让位给项目那一行,必须落在同一次 DOM 更新里 —— ❌ 一刻两行都在,❌ 一刻两行都不在。
 * 真 Chromium、两棵 React 树(壳画聊天列表进侧栏那一格,会话页画列表尾巴上的示例行),像真机验收那样每次 DOM 变动记一次行。
 * 项目那一行两条路出现:群进了聊天列表(壳那棵树),或账号的项目表先有了它(会话页这棵树)。账号上记群那一下故意不答:
 * 让位 ❌ 等它。
 */
import { runInAction } from 'mobx';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';

const chatStore = vi.hoisted(() => {
  type Chat = { id: string; kind: 'group'; name: string; unread_count: number; is_muted: boolean };
  let snapshot = { chats: [] as Chat[], loadingChats: false };
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (chats: Chat[]) => { snapshot = { chats, loadingChats: false }; for (const listener of listeners) listener(); },
    group: (id: string): Chat => ({ id, kind: 'group', name: id, unread_count: 0, is_muted: false }),
  };
});
const OWNER = vi.hoisted(() => ({ ownerId: 'u1', ownerName: 'Ana', ownerAvatar: null }));
const NO_GROUPS = vi.hoisted(() => new Set<string>());

// 壳那棵树:真的 ChatListSlotHost(它把聊天列表画进侧栏那一格、把 listedGroups 发给会话页);聊天列表的行用一个替身,
// 和真的一样从同一份聊天 store 读、在同一次渲染里画。账号上还没进聊天列表的项目,也和真的一样(#2548 ChatListPanel 的
// OneListProjectSlot)在列表里留一格,会话页(真的 SidebarOneList)把项目那一行画进去。
vi.mock('@/store/chatContext', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useChatStore: () => useSyncExternalStore(chatStore.subscribe, chatStore.get) };
});
vi.mock('@/components/ChatListPanel', async () => {
  const { useCallback, useSyncExternalStore } = await import('react');
  const { useOneListProjectLines } = await import('@/lib/sidebarOneList');
  const { readShellSlots } = await import('@/lib/shellSlots');
  const { oneListProjectSlotKey } = await import('@/lib/sidebarChatsBridge');
  // The place registers once per element, as the real one's callback ref does: a new ref each render would re-register it.
  const Place = ({ chatId }: { chatId: string }) => {
    const place = useCallback((element: HTMLDivElement) => {
      const key = oneListProjectSlotKey(chatId);
      readShellSlots()!.setSlot(key, element);
      return () => readShellSlots()!.setSlot(key, null);
    }, [chatId]);
    return <div ref={place} />;
  };
  return {
    ChatListPanel: () => {
      const { chats } = useSyncExternalStore(chatStore.subscribe, chatStore.get);
      const lines = useOneListProjectLines(true, chats as never);
      return (
        <>
          {lines.map((line) => <Place key={`line:${line.projectChatId}`} chatId={line.projectChatId} />)}
          {chats.map((chat) => <div key={chat.id} data-row={`chat:${chat.id}`} />)}
        </>
      );
    },
  };
});
vi.mock('@/components/chat/InnerSidebarTopics', () => ({ InnerSidebarTopics: () => null }));
vi.mock('@/hooks/useNativeAgentChats', () => ({ useNativeAgentChats: <T,>(chats: T) => chats }));
vi.mock('@/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => () => {} }));
vi.mock('@/lib/projectGroupChatsBridge', () => ({ useProjectGroupChats: () => NO_GROUPS }));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => OWNER }));
// 会话页这棵树:真的 SidebarOneList 与 useSampleProject;行本身用替身(这里只数行)。
vi.mock('@/lib/sampleProject', () => ({
  readSampleProject: async () => ({ version: 1, dismissed: false }),
  subscribeSampleProject: () => () => {},
  dismissSampleProject: async () => {},
}));
vi.mock('@renderer/features/sidebar/sample-project-row', () => ({ SampleProjectSidebar: () => <div data-row="sample" /> }));
vi.mock('@renderer/features/sidebar/project-item', () => ({
  SidebarProjectItem: ({ projectId }: { projectId: string }) => <div data-row={`project:${projectId}`} />,
}));
vi.mock('@renderer/features/sidebar/one-list-task-row', () => ({ OneListTaskRow: () => null }));
vi.mock('@renderer/features/projects/components/account-projects-error', () => ({ AccountProjectsError: () => null }));
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ isLeftOpen: true }) }));
vi.mock('@renderer/lib/stores/app-state', async () => {
  const { accountProjectsStore } = await import('@renderer/features/projects/stores/account-projects-store');
  return {
    sidebarStore: {
      // 和 sidebar-store 一样:账号上没归档的项目一个一行(这里没有本地项目,行 id 就是群)。
      get sidebarProjects() {
        return accountProjectsStore.projects.filter((project) => !project.archived).map((project) => ({ id: project.chatId, chatId: project.chatId }));
      },
      tasksWithoutAgent: [],
    },
  };
});

const { ChatListSlotHost } = await import('@/components/ChatListSlotHost');
const { SidebarOneList } = await import('@renderer/features/sidebar/sidebar-one-list');
const { accountProjectsStore } = await import('@renderer/features/projects/stores/account-projects-store');
const { convertSampleProject, resetSampleConversion, sampleConversion } = await import('@renderer/features/sample-project/sample-conversion');
const { whenGroupRowShown } = await import('@renderer/features/sample-project/sample-group-row');
import type { SampleConversionDeps } from '@renderer/features/sample-project/sample-conversion';

let session: HTMLDivElement;
let shell: HTMLDivElement;
let sessionRoot: Root;
let shellRoot: Root;
let observer: MutationObserver | null = null;

const rows = () => [...session.querySelectorAll<HTMLElement>('[data-row]')].map((row) => row.dataset.row ?? '');

beforeEach(async () => {
  resetSampleConversion();
  runInAction(() => { accountProjectsStore.list = []; });
  chatStore.set([chatStore.group('chat-old')]);
  session = document.body.appendChild(document.createElement('div'));
  shell = document.body.appendChild(document.createElement('div'));
  sessionRoot = createRoot(session);
  shellRoot = createRoot(shell);
  sessionRoot.render(<SidebarOneList />);
  shellRoot.render(<ChatListSlotHost />);
  await until('the chat list and the sample are drawn', () => rows().join(' | ') === 'chat:chat-old | sample');
});

afterEach(() => {
  observer?.disconnect();
  observer = null;
  shellRoot.unmount();
  sessionRoot.unmount();
  shell.remove();
  session.remove();
  runInAction(() => { accountProjectsStore.list = []; });
});

/** Turns the sample into a project whose group is `chat-new`; recording that group on the account never answers. */
function convert(opened: string[]) {
  const deps: SampleConversionDeps = {
    owner: OWNER.ownerId,
    signedIn: () => true,
    readKey: async () => ({ version: 1, dismissed: false }),
    recordProject: async () => {},
    recordGroup: () => new Promise<void>(() => {}),
    dismiss: async () => {},
    dismissFailed: () => {},
    projectExists: () => false,
    defaultDirectory: async () => '/Users/p/projects',
    pathTaken: async () => false,
    createProject: async () => 'project-1',
    projectFolder: async () => 'project-1:folder',
    writeFile: async () => {},
    ensureGroup: async () => 'chat-new',
    whenRowShown: (chatId, _nudge, open) => whenGroupRowShown(chatId, open, 10_000),
    handOff: (projectId) => { opened.push(projectId); },
    handOffToGroup: () => {},
    logError: () => {},
  };
  void convertSampleProject(deps, { name: '周末去杭州', files: [] });
}

/** Every DOM update from here on, as the rows it leaves. */
function recordRows(): string[][] {
  const seen: string[][] = [];
  observer = new MutationObserver(() => seen.push(rows()));
  observer.observe(session, { childList: true, subtree: true });
  return seen;
}

function expectOneOfTheTwo(seen: string[][], projectRow: string) {
  expect(seen.length).toBeGreaterThan(0);
  for (const frame of seen) {
    const both = frame.includes('sample') && frame.includes(projectRow);
    const neither = !frame.includes('sample') && !frame.includes(projectRow);
    expect(both || neither, `rows in one update: ${frame.join(' | ')}`).toBe(false);
  }
  expect(seen.at(-1)).toContain(projectRow);
}

it('the project group arriving in the chat list: the sample row is gone in that same update, and the project is opened in it', async () => {
  const opened: string[] = [];
  convert(opened);
  await until('the group is made', () => sampleConversion.chatId === 'chat-new');
  const seen = recordRows();
  // Realtime brings the new group into the shell's chat list, outside any React event.
  setTimeout(() => chatStore.set([chatStore.group('chat-new'), chatStore.group('chat-old')]), 0);
  await until('the project row is drawn', () => rows().includes('chat:chat-new'));
  await until('the observer has reported', () => seen.length > 0);
  expectOneOfTheTwo(seen, 'chat:chat-new');
  expect(opened).toEqual(['project-1']);
  expect(sampleConversion.status).toBe('handed-off');
});

it('the account project list holding it before the chat list does: same, through the account project row', async () => {
  const opened: string[] = [];
  convert(opened);
  await until('the group is made', () => sampleConversion.chatId === 'chat-new');
  const seen = recordRows();
  setTimeout(() => runInAction(() => {
    accountProjectsStore.list = [{ chatId: 'chat-new', name: '周末去杭州', archived: false, bindings: [] }] as never;
  }), 0);
  await until('the project row is drawn', () => rows().includes('project:chat-new'));
  await until('the observer has reported', () => seen.length > 0);
  expectOneOfTheTwo(seen, 'project:chat-new');
  expect(opened).toEqual(['project-1']);
});
