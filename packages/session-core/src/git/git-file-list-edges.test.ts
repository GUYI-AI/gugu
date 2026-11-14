import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createBoundExec } from '../exec/bound-exec';
import { GitWorktree, type GitWorktreeOptions } from './git-worktree';

const run = promisify(execFile);
async function fixture(test: (worktree: GitWorktree, root: string, git: (args: string[]) => Promise<string>) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'gugu-git-filenames-'));
  const git = async (args: string[]) => (await run('git', args, { cwd: root })).stdout;
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.test']);
  await writeFile(path.join(root, 'base.md'), 'base\n'); await git(['add', '.']); await git(['commit', '-m', 'base']);
  const repository = { gitCommonDir: path.join(root, '.git'), registerWorktree: () => () => {} };
  const worktree = new GitWorktree({ worktree: root, gitDir: repository.gitCommonDir, repository,
    exec: createBoundExec({ file: 'git', cwd: root }), watcher: {} } as unknown as GitWorktreeOptions);
  try { await test(worktree, root, git); }
  finally { await worktree.dispose(); await rm(root, { recursive: true, force: true }); }
}

describe('Git file list filename fidelity', () => {
  it('keeps the rename destination and its counts', async () => {
    await fixture(async (worktree, root, git) => {
      await git(['mv', 'base.md', '资料.md']);
      expect(await worktree.getChangedFiles({ kind: 'staged' })).toEqual([
        expect.objectContaining({ path: path.join(root, '资料.md'), status: 'renamed', additions: 0, deletions: 0 }),
      ]);
    });
  });
  it('does not read unsupported filenames as images through inherited MIME keys', async () => {
    await fixture(async (worktree, root, git) => {
      await writeFile(path.join(root, 'note.__proto__'), 'plain'); await git(['add', '.']); await git(['commit', '-m', 'plain file']);
      expect(await worktree.getImageAtRef('note.__proto__', 'HEAD')).toEqual({ kind: 'unavailable', reason: 'unsupported' });
    });
  });
  it('keeps Unicode paths and line counts in commit files', async () => {
    await fixture(async (worktree, root, git) => {
      const name = '资料.md';
      await writeFile(path.join(root, name), 'one\ntwo\n'); await git(['add', '.']); await git(['commit', '-m', 'add note']);
      const hash = (await git(['rev-parse', 'HEAD'])).trim();
      expect(await worktree.getCommitFiles(hash)).toContainEqual(expect.objectContaining({ path: path.join(root, name), additions: 2, deletions: 0 }));
    });
  });
  it('keeps Unicode and whitespace paths and line counts in changed files', async () => {
    await fixture(async (worktree, root, git) => {
      const names = ['资料.md', ' leading.md'];
      for (const name of names) await writeFile(path.join(root, name), 'one\ntwo\n');
      await git(['add', '.']);
      const changes = await worktree.getChangedFiles({ kind: 'staged' });
      for (const name of names) expect(changes).toContainEqual(expect.objectContaining({ path: path.join(root, name), additions: 2, deletions: 0 }));
    });
  });
});
