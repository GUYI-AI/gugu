import { describe, expect, it } from 'vitest';
import { followInnerSidebar, viewAnchor, type InnerSidebarAnchor } from './inner-sidebar-anchor';

const group: InnerSidebarAnchor = { kind: 'group', chatId: 'g' };
const project: InnerSidebarAnchor = { kind: 'project', chatId: 'pg' };
const listedIn = (members: Record<string, string[]>) => (anchor: InnerSidebarAnchor, sessionId: string) =>
  (members[anchor.chatId] ?? []).includes(sessionId);
const noAgent = () => null;
const solo: InnerSidebarAnchor = { kind: 'agent', chatId: 'dm-solo', agentUserId: 'solo' };
// #2574 the sessions of a standalone agent that has sub-agents open its column.
const agentOf = (sessionId: string) => (sessionId === 'solo-task' ? solo : null);

describe('which chat the inner sidebar shows', () => {
  it('an ordinary group shows it; a direct message does not; an unknown chat waits for the summaries', () => {
    expect(viewAnchor({ kind: 'chat', chatId: 'g', chatKind: 'group', projectGroup: false })).toEqual(group);
    expect(viewAnchor({ kind: 'chat', chatId: 'dm', chatKind: 'dm', projectGroup: false })).toBeNull();
    expect(viewAnchor({ kind: 'chat', chatId: 'ai', chatKind: 'ai', projectGroup: false })).toBeNull();
    expect(viewAnchor({ kind: 'chat', chatId: 'g', chatKind: null, projectGroup: false })).toBeNull();
  });

  it('a project shows its project group; a project with no group has no inner sidebar', () => {
    expect(viewAnchor({ kind: 'project', chatId: 'pg' })).toEqual(project);
    expect(viewAnchor({ kind: 'project', chatId: undefined })).toBeNull();
  });

  it('a project group opened as a chat is still a project', () => {
    expect(viewAnchor({ kind: 'chat', chatId: 'pg', chatKind: 'group', projectGroup: true })).toEqual(project);
  });

  it('opening one of its agents keeps the column; any other session, chat or place closes it', () => {
    const members = listedIn({ g: ['mine-in-g'] });
    expect(followInnerSidebar(group, { kind: 'session', sessionId: 'mine-in-g' }, members, noAgent)).toBe(group);
    expect(followInnerSidebar(group, { kind: 'session', sessionId: 'standalone' }, members, noAgent)).toBeNull();
    expect(followInnerSidebar(null, { kind: 'session', sessionId: 'mine-in-g' }, members, noAgent)).toBeNull();
    expect(followInnerSidebar(group, { kind: 'chat', chatId: 'dm', chatKind: 'dm', projectGroup: false }, members, noAgent)).toBeNull();
    expect(followInnerSidebar(group, { kind: 'other' }, members, noAgent)).toBeNull();
  });

  it('opening another group or project moves the column to it', () => {
    const members = listedIn({});
    expect(followInnerSidebar(group, { kind: 'project', chatId: 'pg' }, members, noAgent)).toEqual(project);
    expect(followInnerSidebar(project, { kind: 'chat', chatId: 'g', chatKind: 'group', projectGroup: false }, members, noAgent)).toEqual(group);
  });

  it("#2574 a standalone agent's own session opens its column; one of its sub-agents keeps it; anything else closes it", () => {
    const members = listedIn({ 'dm-solo': ['sub'] });
    expect(followInnerSidebar(null, { kind: 'session', sessionId: 'solo-task' }, members, agentOf)).toBe(solo);
    expect(followInnerSidebar(group, { kind: 'session', sessionId: 'solo-task' }, members, agentOf)).toBe(solo);
    expect(followInnerSidebar(solo, { kind: 'session', sessionId: 'sub' }, members, agentOf)).toBe(solo);
    expect(followInnerSidebar(null, { kind: 'session', sessionId: 'sub' }, members, agentOf)).toBeNull();
    expect(followInnerSidebar(solo, { kind: 'session', sessionId: 'elsewhere' }, members, agentOf)).toBeNull();
    expect(followInnerSidebar(solo, { kind: 'chat', chatId: 'g', chatKind: 'group', projectGroup: false }, members, agentOf)).toEqual(group);
  });

  it('a session listed in the open column keeps that column, even one that would open a column of its own', () => {
    const members = listedIn({ g: ['solo-task'] });
    expect(followInnerSidebar(group, { kind: 'session', sessionId: 'solo-task' }, members, agentOf)).toBe(group);
  });
});
