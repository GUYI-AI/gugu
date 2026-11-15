import { link, mkdtemp, open, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readWindowFrame, writeWindowFrame, type FrameWriteFs } from './disk-frame';
import type { WindowFrameKey } from './frame';
import { createWindowBudget } from './read-budget';

const body: WindowFrameKey = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1, kind: 'body', cursor: 'body:1' };
const head: WindowFrameKey = { ...body, kind: 'head', cursor: 'current' };

async function exercise(failAt = '') {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-sync-order-'));
  const calls: string[] = []; let phase = 'body';
  const fs: FrameWriteFs = { link: async (...args) => { calls.push(`${phase}.link`); return link(...args); },
    rename: async (...args) => { calls.push(`${phase}.rename`); return rename(...args); }, rm,
    open: async (path, flags, mode) => {
      const file = await open(path, flags, mode), sync = file.sync.bind(file);
      const event = `${phase}.${path === directory ? 'directory' : 'file'}.sync`;
      file.sync = async () => { calls.push(event); if (event === failAt) throw new Error(failAt); await sync(); };
      return file;
    } };
  try {
    await writeWindowFrame(directory, head, Buffer.from('old'));
    const publish = async () => {
      await writeWindowFrame(directory, body, Buffer.from('content'), fs);
      phase = 'head'; await writeWindowFrame(directory, head, Buffer.from('new'), fs);
      calls.push('returned');
    };
    if (failAt) {
      await expect(publish()).rejects.toThrow(failAt);
      const old = await readWindowFrame(directory, head, createWindowBudget());
      expect(old.kind === 'hit' && Buffer.from(old.bytes).toString()).toBe('old');
      expect(calls).not.toContain('returned');
    } else {
      await publish();
      expect(calls).toEqual(['body.file.sync', 'body.link', 'body.directory.sync', 'head.file.sync', 'head.rename', 'head.directory.sync', 'returned']);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it('requires file sync before linking/renaming and directory sync before returning', async () => { await exercise(); });
it('propagates pre-publication durability failures while retaining the old head', async () => {
  for (const failure of ['body.file.sync', 'body.directory.sync', 'head.file.sync']) await exercise(failure);
});
