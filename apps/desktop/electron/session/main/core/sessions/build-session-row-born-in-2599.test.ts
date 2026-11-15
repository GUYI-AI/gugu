import { describe, expect, it } from 'vitest';
import { buildSessionRow } from './build-session-row';
import { sessionBornInChatId } from '@shared/core/sessions/sessions';

/**
 * #2599 An agent lives where it was created: the group it joined at birth, else the chat whose composer dispatched it.
 * The row keeps both facts (the left sidebar reads them through the session directory), so joining a group later cannot
 * change where it lives.
 */
const base = {
  id: 's1',
  projectId: 'p1',
  workspaceId: 'w1',
  agentDisplayName: 'Codex 1',
  claimsFirstSpawn: false,
  provider: 'codex' as never,
  origin: { kind: 'create' as const, firstUtterance: 'hi' },
  permissionMode: 'edit' as const,
};

describe('where an agent was created is kept on its row (#2599)', () => {
  it.each(['acp', 'pty'] as const)('a %s session keeps the group it was born in', (runtime) => {
    const row = buildSessionRow({ ...base, runtime, birthChatId: 'group-1', taskChatId: 'group-1' });
    expect(row.config).toMatchObject({ birthChatId: 'group-1', taskChatId: 'group-1' });
    expect(sessionBornInChatId(row.config)).toBe('group-1');
  });

  it('dispatched from a direct message: born in that chat (no group to join)', () => {
    const row = buildSessionRow({ ...base, runtime: 'acp', taskChatId: 'dm-1' });
    expect(row.config).not.toHaveProperty('birthChatId');
    expect(sessionBornInChatId(row.config)).toBe('dm-1');
  });

  it('created with no conversation (Create agent): born nowhere', () => {
    const row = buildSessionRow({ ...base, runtime: 'acp' });
    expect(sessionBornInChatId(row.config)).toBeNull();
  });

  it('an older row with only its task card chat still reads where it was created', () => {
    expect(sessionBornInChatId({ taskChatId: 'group-old' })).toBe('group-old');
    expect(sessionBornInChatId(null)).toBeNull();
  });
});
