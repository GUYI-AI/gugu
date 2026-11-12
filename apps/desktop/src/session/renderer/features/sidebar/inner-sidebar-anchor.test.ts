import { describe, expect, it } from 'vitest';
import { followInnerSidebar, viewAnchor, type InnerSidebarAnchor } from './inner-sidebar-anchor';

const group: InnerSidebarAnchor = { kind: 'group', chatId: 'g' };
const project: InnerSidebarAnchor = { kind: 'project', chatId: 'pg' };
const listedIn = (members: Record<string, string[]>) => (anchor: InnerSidebarAnchor, sessionId: string) =>
  (members[anchor.chatId] ?? []).includes(sessionId);

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
    expect(followInnerSidebar(group, { kind: 'session', sessionId: 'mine-in-g' }, members)).toBe(group);
    expect(followInnerSidebar(group, { kind: 'session', sessionId: 'standalone' }, members)).toBeNull();
    expect(followInnerSidebar(null, { kind: 'session', sessionId: 'mine-in-g' }, members)).toBeNull();
    expect(followInnerSidebar(group, { kind: 'chat', chatId: 'dm', chatKind: 'dm', projectGroup: false }, members)).toBeNull();
    expect(followInnerSidebar(group, { kind: 'other' }, members)).toBeNull();
  });

  it('opening another group or project moves the column to it', () => {
    const members = listedIn({});
    expect(followInnerSidebar(group, { kind: 'project', chatId: 'pg' }, members)).toEqual(project);
    expect(followInnerSidebar(project, { kind: 'chat', chatId: 'g', chatKind: 'group', projectGroup: false }, members)).toEqual(group);
  });
});
