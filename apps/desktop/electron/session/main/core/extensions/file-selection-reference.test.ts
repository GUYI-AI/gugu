import { describe, expect, it, vi } from 'vitest';

// Only the task's working copy is on this computer.
vi.mock('./app-files', () => ({
  localRootOf: async ({ workspace }: { workspace: string }) => {
    if (workspace !== 'session:here') throw Object.assign(new Error('not here'), { code: 'not-found' });
    return { workspaceRoot: '/home/me/task', projectId: 'p-1', workspaceId: null };
  },
}));
vi.mock('./extension-send', () => ({
  chatSelectionPillsForApp: async (chat: string, refs: Array<{ file: { id: string } }>) =>
    refs.map(({ file }) => ({ label: 'notes.md', target: `gugu-file://${file.id}?v=2#chat=${chat}` })),
}));
const { fileReferenceOf } = await import('./file-selection-reference');

const folders = [
  { workspace: 'folder:mac/ws-1', path: '/Users/me/work', machine: 'mac', online: true },
  { workspace: 'folder:win/ws-2', path: 'D:\\work\\repo', machine: 'win', online: false },
];

describe('a selected file, named where it lives', () => {
  it('a working copy here: its path on this computer', async () => {
    expect(await fileReferenceOf({ workspace: 'session:here', id: 'src/a.ts' }, undefined, { chat: null, folders })).toEqual({ name: 'a.ts', target: '/home/me/task/src/a.ts' });
  });

  it('a group folder on another machine: its path there, in that machine\'s own separators, with the machine named', async () => {
    expect(await fileReferenceOf({ workspace: 'folder:mac/ws-1', id: 'AGENTS.md' }, undefined, { chat: 'g', folders })).toEqual({ name: 'AGENTS.md · mac', target: '/Users/me/work/AGENTS.md' });
    expect(await fileReferenceOf({ workspace: 'folder:win/ws-2', id: 'docs/a.md' }, undefined, { chat: 'g', folders })).toEqual({ name: 'a.md · win', target: 'D:\\work\\repo\\docs\\a.md' });
  });

  it('a chat folder\'s file: its link, in its own chat or the page\'s', async () => {
    expect(await fileReferenceOf({ id: 'item-1' }, undefined, { chat: 'g', folders })).toEqual({ name: 'notes.md', target: 'gugu-file://item-1?v=2#chat=g' });
    expect(await fileReferenceOf({ chat: 'h', id: 'item-1' }, undefined, { chat: 'g', folders })).toEqual({ name: 'notes.md', target: 'gugu-file://item-1?v=2#chat=h' });
  });

  it('nothing it can be named by from here: another machine\'s session, or a chat file on a page of no chat', async () => {
    expect(await fileReferenceOf({ workspace: 'session:elsewhere', id: 'a.md' }, undefined, { chat: 'g', folders })).toBeNull();
    expect(await fileReferenceOf({ id: 'item-1' }, undefined, { chat: null, folders })).toBeNull();
  });
});
