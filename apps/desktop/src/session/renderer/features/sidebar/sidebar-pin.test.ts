import { describe, expect, it } from 'vitest';
import { pinnedSidebarAgents, sidebarPinMenuAction, type SidebarAgentHome, type SidebarPinCandidate } from './sidebar-pin';

// #2548 固定到左侧栏: when the session menu offers it, and which agents the left list puts at the top.
describe('sidebarPinMenuAction', () => {
  const topLevel = { switchOn: true, parentSessionId: null, isPinnedToSidebar: false };

  it('offers nothing while the desktop sidebar switch is off, whatever the session', () => {
    expect(sidebarPinMenuAction({ ...topLevel, switchOn: false })).toBeNull();
    expect(sidebarPinMenuAction({ ...topLevel, switchOn: false, isPinnedToSidebar: true })).toBeNull();
  });

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
    'in-project': { kind: 'project', id: 'project-1', name: 'gugu' },
    older: { kind: 'project', id: 'project-1', name: 'gugu' },
    child: { kind: 'project', id: 'project-1', name: 'gugu' },
    archived: { kind: 'group', id: 'chat-1', name: '运营群' },
    unpinned: { kind: 'group', id: 'chat-1', name: '运营群' },
  };
  const homeOf = (session: Row) => homes[session.sessionId] ?? null;

  it('lists pinned top-level agents that live in a group or project, newest first, each with where it lives', () => {
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
      ['in-project', 'gugu', 'project'],
      ['older', 'gugu', 'project'],
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
