import { mkdtemp, appendFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

it('accepts an append between descriptor stat and pathname stat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-tail-race-'));
  const path = join(directory, 'source.jsonl');
  await writeFile(path, 'first\n');
  let appended = false;
  const source = await openWindowByteSource(path, async target => {
    if (!appended) { appended = true; await appendFile(target, 'next\n'); }
    return stat(target, { bigint: true });
  });
  try {
    const during = await source.snapshot();
    const after = await source.snapshot();
    expect(during.size).toBe(6);
    expect(after.size).toBe(11);
    expect(after.sourceInstance).toBe(during.sourceInstance);
    expect(after.snapshotRevision).not.toBe(during.snapshotRevision);
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});
