import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@gugu/session-shared';
import type { FolderRecord } from '@shared/core/folders/folders';
import { runGroupFolderAgentAction, type GroupFolderOps } from './agent-actions';

const folder = (over: Partial<FolderRecord> = {}): FolderRecord => ({
  id: 'w1', path: '/repo', chatId: 'g1', sort: 1, gitless: false, baseRef: null, attachedAt: null, branch: 'main', sessionIds: ['s1'], ...over,
});

function ops(over: Partial<GroupFolderOps> = {}): GroupFolderOps {
  return {
    list: vi.fn(async () => [folder()]),
    inspect: vi.fn(async () => ({ isDirectory: true, isGitRepo: true })),
    bind: vi.fn(async () => ok(folder())),
    unbind: vi.fn(async () => ok(folder({ chatId: null }))),
    ...over,
  };
}

describe('group folder agent actions', () => {
  it('lists folders in the agent\'s words', async () => {
    expect(await runGroupFolderAgentAction({ action: 'group_folders', chat_id: 'g1' }, ops())).toEqual([
      { chat_id: 'g1', folder_id: 'w1', path: '/repo', git: true, branch: 'main', sessions: [{ session_id: 's1' }] },
    ]);
  });

  it('binds a new folder with an unbind undo', async () => {
    const answer = await runGroupFolderAgentAction({ action: 'group_folder_bind', chat_id: 'g1', path: '/repo' }, ops());
    expect(answer).toMatchObject({ folder_id: 'w1', undo: { tool: 'group_folder_unbind', chat_id: 'g1', folder_id: 'w1' } });
  });

  it('answers folder_bound_elsewhere without moving, and moves back on undo after move:true', async () => {
    const elsewhere = ops({ bind: vi.fn(async () => err({ type: 'bound-elsewhere' as const, id: 'w1', chatId: 'g0' })) });
    expect(await runGroupFolderAgentAction({ action: 'group_folder_bind', chat_id: 'g1', path: '/repo' }, elsewhere))
      .toMatchObject({ folder_bound_elsewhere: { chat_id: 'g0' }, folder_id: 'w1' });
    const moving = ops({ inspect: vi.fn(async () => ({ isDirectory: true, isGitRepo: true, existing: folder({ chatId: 'g0' }) })) });
    expect(await runGroupFolderAgentAction({ action: 'group_folder_bind', chat_id: 'g1', path: '/repo', move: true }, moving))
      .toMatchObject({ moved_from: { chat_id: 'g0' }, undo: { tool: 'group_folder_bind', chat_id: 'g0', path: '/repo', move: true } });
    expect(moving.bind).toHaveBeenCalledWith({ path: '/repo', chatId: 'g1', move: true });
  });

  it('refuses to unbind a folder that is not in the named group', async () => {
    const api = ops();
    await expect(runGroupFolderAgentAction({ action: 'group_folder_unbind', chat_id: 'g1', folder_id: 'other' }, api)).rejects.toThrow(/not bound to this group/);
    expect(api.unbind).not.toHaveBeenCalled();
    expect(await runGroupFolderAgentAction({ action: 'group_folder_unbind', chat_id: 'g1', folder_id: 'w1' }, api))
      .toMatchObject({ unbound: true, undo: { tool: 'group_folder_bind', chat_id: 'g1', path: '/repo' } });
  });
});
