import { mkdtemp, appendFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openWindowByteSource } from './file-source';

it('keeps physical identity on append but detects rewrites and pathname replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-tail-source-'));
  const path = join(directory, 'source.jsonl');
  await writeFile(path, 'first\n');
  const source = await openWindowByteSource(path);
  try {
    const first = await source.snapshot();
    await appendFile(path, 'next\n');
    const appended = await source.snapshot();
    expect(appended.sourceInstance).toBe(first.sourceInstance);
    expect(appended.snapshotRevision).not.toBe(first.snapshotRevision);
    await writeFile(path, 'other\ntext\n');
    const rewritten = await source.snapshot();
    expect(rewritten.size).toBe(appended.size);
    expect(rewritten.snapshotRevision).not.toBe(appended.snapshotRevision);
    await writeFile(join(directory, 'replacement'), 'other\ntext\n');
    await rename(join(directory, 'replacement'), path);
    await expect(source.snapshot()).rejects.toThrow('replaced');
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});
