import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readWindowFrame, writeWindowFrame } from './disk-frame';
import { encodeWindowFrame, windowFrameName, type WindowFrameKey } from './frame';
import { createWindowBudget, WINDOW_LIMITS, WindowBudgetExceeded } from './read-budget';

const key: WindowFrameKey = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1, kind: 'body', cursor: 'item:12' };

it('persists immutable frames, meters actual reads and replaces only the small head', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-durable-frame-'));
  try {
    const body = Buffer.from('original');
    await writeWindowFrame(directory, key, body);
    const budget = createWindowBudget();
    expect((await readWindowFrame(directory, key, budget)).kind).toBe('hit');
    expect(budget.counters.indexBytes).toBe(encodeWindowFrame(key, body).length);
    await expect(writeWindowFrame(directory, key, Buffer.from('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
    const original = await readWindowFrame(directory, key, createWindowBudget());
    expect(original.kind === 'hit' && Buffer.from(original.bytes).toString()).toBe('original');
    const head = { ...key, kind: 'head' as const, cursor: 'current' };
    await writeWindowFrame(directory, head, Buffer.from('commit1'));
    await writeWindowFrame(directory, head, Buffer.from('commit2'));
    const latest = await readWindowFrame(directory, head, createWindowBudget());
    expect(latest.kind === 'hit' && Buffer.from(latest.bytes).toString()).toBe('commit2');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('distinguishes absent, corrupt and budget exhaustion without allocating an oversized file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-corrupt-frame-'));
  try {
    expect(await readWindowFrame(directory, key, createWindowBudget())).toEqual({ kind: 'miss', reason: 'not_found' });
    await writeWindowFrame(directory, key, Buffer.from('data'));
    await expect(readWindowFrame(directory, key, createWindowBudget({ ...WINDOW_LIMITS, indexBytes: 1 })))
      .rejects.toBeInstanceOf(WindowBudgetExceeded);
    const corrupt = encodeWindowFrame(key, Buffer.from('data'));
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await writeFile(join(directory, windowFrameName(key)), corrupt);
    expect(await readWindowFrame(directory, key, createWindowBudget())).toEqual({ kind: 'miss', reason: 'checksum' });
    await writeFile(join(directory, windowFrameName(key)), corrupt.subarray(0, 12));
    expect(await readWindowFrame(directory, key, createWindowBudget())).toEqual({ kind: 'miss', reason: 'format' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
