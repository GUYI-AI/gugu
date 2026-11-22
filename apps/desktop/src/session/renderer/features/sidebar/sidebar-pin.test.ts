import { describe, expect, it } from 'vitest';
import type { ChatAgentEntry } from './chat-agents';
import {
  pinnedSidebarAgents,
  sidebarAgentHome,
  sidebarPinMenuAction,
  type SidebarAgentHome,
  type SidebarHomeCandidate,
  type SidebarPinCandidate,
} from './sidebar-pin';

// #2548 固定到左侧栏: when the session menu offers it, and which agents the left list puts at the top.
describe('sidebarPinMenuAction', () => {
  const topLevel = { parentSessionId: null, isPinnedToSidebar: false };

  it('offers nothing for a child session: it is never a row of the left list', () => {
    expect(sidebarPinMenuAction({ ...topLevel, parentSessionId: 'parent-1' })).toBeNull();
    expect(sidebarPinMenuAction({ ...topLevel, parentSessionId: 'parent-1', isPinnedToSidebar: true })).toBeNull();
  });

  it('offers pin for an unpinned top-level session and unpin for a pinned one', () => {
    expect(sidebarPinMenuAction(topLevel)).toBe('pin');
    expect(sidebarPinMenuAction({ ...topLevel, parentSessionId: undefined, isPinnedToSidebar: undefined })).toBe('pin');
    expect(sidebarPinMenuAction({ ...topLevel, isPinnedToSidebar: true })).toBe('unpin');
  });
});

describe('pinnedSidebarAgents', () => {
  type Row = SidebarPinCandidate & { title: string };
  const row = (sessionId: string, facts: Partial<Row> = {}): Row => ({
    sessionId,
    title: sessionId,
    parentSessionId: null,
    isPinnedToSidebar: true,
    archivedAt: null,
    lastInteractedAt: '2026-11-10T00:00:00.000Z',
    ...facts,
  });
  const homes: Record<string, SidebarAgentHome & { id: string }> = {
    'in-group': { kind: 'group', id: 'chat-1', name: '运营群' },
    'in-project': { kind: 'group', id: 'chat-2', name: 'gugu' },
    older: { kind: 'group', id: 'chat-2', name: 'gugu' },
    child: { kind: 'group', id: 'chat-2', name: 'gugu' },
    archived: { kind: 'group', id: 'chat-1', name: '运营群' },
    unpinned: { kind: 'group', id: 'chat-1', name: '运营群' },
  };
  const homeOf = (session: Row) => homes[session.sessionId] ?? null;

  it('lists pinned top-level agents that live in a group, newest first, each with where it lives', () => {
    const result = pinnedSidebarAgents(
      [
        row('older', { lastInteractedAt: '2026-11-01T00:00:00.000Z' }),
        row('in-group', { lastInteractedAt: '2026-11-11T09:00:00.000Z' }),
        row('in-project', { lastInteractedAt: '2026-11-11T08:00:00.000Z' }),
      ],
      homeOf
    );
    expect(result.map(({ session, home }) => [session.title, home.name, home.kind])).toEqual([
      ['in-group', '运营群', 'group'],
      ['in-project', 'gugu', 'group'],
      ['older', 'gugu', 'group'],
    ]);
    // The caller's own home shape (an id to open it) comes back as given.
    expect(result[0].home).toBe(homes['in-group']);
  });

  it('leaves out children, archived, unpinned and standalone agents (a standalone agent is a row already)', () => {
    const result = pinnedSidebarAgents(
      [
        row('child', { parentSessionId: 'in-project' }),
        row('archived', { archivedAt: '2026-11-02T00:00:00.000Z' }),
        row('unpinned', { isPinnedToSidebar: false }),
        row('standalone'),
        row('in-project'),
      ],
      homeOf
    );
    expect(result.map(({ session }) => session.sessionId)).toEqual(['in-project']);
  });

  it('puts sessions never interacted with last, and counts a session listed twice once (the later listing wins)', () => {
    const result = pinnedSidebarAgents(
      [
        row('in-group', { lastInteractedAt: null }),
        row('in-project', { lastInteractedAt: '2026-11-01T00:00:00.000Z', title: 'stale' }),
        row('in-project', { lastInteractedAt: '2026-11-01T00:00:00.000Z', title: 'fresh' }),
      ],
      homeOf
    );
    expect(result.map(({ session }) => session.title)).toEqual(['fresh', 'in-group']);
  });
});

describe('sidebarAgentHome', () => {
  const entry = (facts: Partial<ChatAgentEntry> = {}): ChatAgentEntry => ({
    id: 's1',
    projectId: 'tasks',
    time: 0,
    agentUserId: 'a1',
    ...facts,
  });
  // `app-group` is the group the App folder is bound to; `tasks` is the task workspace (in no group).
  const group = (name: string, chatId: string): SidebarHomeCandidate => ({
    kind: 'group',
    name,
    scope: { here: (id) => id === chatId },
  });

  it('is the group whose inner-sidebar column lists the agent: where it was created (#2599), or its folder\'s group', () => {
    expect(sidebarAgentHome(entry({ bornInChatId: 'ops' }), [group('其他群', 'other'), group('运营群', 'ops')])?.name).toBe('运营群');
    expect(sidebarAgentHome(entry({ groupChatId: 'app-group' }), [group('App', 'app-group')])?.name).toBe('App');
    expect(sidebarAgentHome(entry({ bornInChatId: 'app-group' }), [group('App', 'app-group')])?.name).toBe('App');
  });

  it('the group of its folder is its home, not the group it was created in', () => {
    const home = sidebarAgentHome(entry({ groupChatId: 'app-group', bornInChatId: 'ops' }), [group('运营群', 'ops'), group('App', 'app-group')]);
    expect(home).toMatchObject({ kind: 'group', name: 'App' });
  });

  it('is null for a standalone agent (created in a DM or with Create agent), or a session without an agent in no group', () => {
    expect(sidebarAgentHome(entry({ bornInChatId: 'dm' }), [group('运营群', 'ops'), group('App', 'app-group')])).toBeNull();
    expect(sidebarAgentHome(entry(), [group('运营群', 'ops')])).toBeNull();
    expect(sidebarAgentHome(entry({ agentUserId: undefined }), [group('运营群', 'ops')])).toBeNull();
  });
});
