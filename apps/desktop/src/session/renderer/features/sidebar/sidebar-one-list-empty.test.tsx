// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// GUYI-AI/gugu#2548 the one list's empty state, mounted (mock v33 新用户): the note while there are no tasks, the import
// box under it while this computer has sessions to import, whether this computer is asked, and where the box goes.

type Session = { conversationId: string; agent?: { userId: string } };
type HistoryState = { page: { matched: number } | null; error: string | null };
const state = vi.hoisted(() => ({
  open: true,
  shell: null as unknown,
  machines: [] as { device_id: string; sessions: Session[] }[],
  history: { page: null, error: null } as HistoryState,
  queries: [] as unknown[],
  navigate: (() => undefined) as (...args: unknown[]) => void,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key) }),
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: state.navigate }) }));
vi.mock('@renderer/lib/layout/layout-provider', () => ({ useWorkspaceLayoutContext: () => ({ isLeftOpen: state.open }) }));
vi.mock('@renderer/features/assistant/assistant-shell', () => ({ useAssistantShell: () => state.shell }));
vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('@/session/shared/remote-sessions/session-directory', () => ({
  useDirectoryDevices: () => state.machines,
  useLiveDeviceSessions: () => ({}),
  deviceSessionsOf: (device: { sessions: Session[] }) => ({ sessions: device.sessions }),
}));
// 会话历史按机器读(useSessionHistoryDirectories):这里只记问了哪几台,这台电脑('local')答 state.history。
vi.mock('@renderer/features/session-history/use-session-history', () => ({
  useSessionHistoryDirectories: (query: unknown, machines: readonly string[]) => {
    state.queries.push(machines.length > 0 ? { query, machines } : null);
    return { byMachine: machines.includes('local') ? { local: state.history } : {}, refresh: () => undefined };
  },
}));

const { SidebarOneListEmpty } = await import('./sidebar-one-list-empty');

let host: HTMLDivElement;
let root: Root;
const render = () => act(async () => root.render(<SidebarOneListEmpty />));
const note = () => host.querySelector<HTMLElement>('[data-sidebar-empty-hint]');
const offer = () => host.querySelector<HTMLElement>('[data-testid="sidebar-import-offer"]');
const asked = () => state.queries.some((query) => query !== null);

beforeEach(() => {
  state.open = true;
  state.shell = { assistantState: 'found', assistant: { id: 'assistant' } };
  state.machines = [{ device_id: 'mac', sessions: [{ conversationId: 's-a', agent: { userId: 'assistant' } }] }];
  state.history = { page: { matched: 3 }, error: null };
  state.queries = [];
  state.navigate = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('SidebarOneListEmpty', () => {
  it('with no tasks: the note, then the import box naming the tools, when this computer has sessions to import', async () => {
    await render();
    expect(state.queries.at(-1)).toEqual({ query: { status: 'not-imported', limit: 1 }, machines: ['local'] });
    expect(note()?.textContent).toContain('sidebar.emptyHintCreatesidebar.emptyHintPlace');
    expect(offer()?.textContent).toBe('sessionHistory.importOffer {"tools":"Claude Code / Codex"}sessionHistory.importOfferAction');
  });

  it('the import box opens the import part of 会话历史', async () => {
    await render();
    await act(async () => offer()!.click());
    expect(state.navigate).toHaveBeenCalledWith('session-history', { source: 'all', status: 'not-imported' });
  });

  it('with no tasks and nothing to import: only the note', async () => {
    state.history = { page: { matched: 0 }, error: null };
    await render();
    expect(note()).not.toBeNull();
    expect(offer()).toBeNull();
  });

  it('with no tasks, before the import part is read: only the note', async () => {
    state.history = { page: null, error: null };
    await render();
    expect(asked()).toBe(true);
    expect(note()).not.toBeNull();
    expect(offer()).toBeNull();
  });

  it('with tasks: nothing, and this computer is not asked', async () => {
    state.machines = [{ device_id: 'mac', sessions: [{ conversationId: 's-1', agent: { userId: 'agent-1' } }] }];
    await render();
    expect(asked()).toBe(false);
    expect(host.innerHTML).toBe('');
  });

  it('while it is not known whose sessions those are: nothing', async () => {
    state.shell = { assistantState: 'loading', assistant: null };
    await render();
    expect(asked()).toBe(false);
    expect(host.innerHTML).toBe('');
  });

  it('while the sidebar is collapsed: nothing', async () => {
    state.open = false;
    await render();
    expect(host.innerHTML).toBe('');
  });
});
