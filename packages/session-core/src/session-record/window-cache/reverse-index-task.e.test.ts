import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as frames from './disk-frame.ts';
import { createWindowBudget, WindowBudgetExceeded } from './read-budget.ts';
import { advanceReverseIndexTask, loadReverseIndexTask, saveReverseIndexTask } from './record-locators.ts';
import { REVERSE_INDEX_BLOCK_BYTES as BLOCK, stepReverseIndex } from './reverse-index-task.ts';
import { windowFrameName } from './frame.ts';
import type { ReverseCheckpoint, SourceSnapshot, WindowByteSource } from './types';

const scope = 'a'.repeat(64), lineage = 'b'.repeat(64);
const job = { scope, sourceLineage: lineage, decoderVersion: 1, jobId: 'test-job' };
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
function fixture(size: number, lf = -1, shortRead = BLOCK) {
  const snapshot: SourceSnapshot = { sourceId: 'source', sourceInstance: 'inode', snapshotRevision: 'revision', size };
  const reads: Array<{ start: number; length: number }> = [];
  const source: WindowByteSource = {
    async snapshot() { return { ...snapshot }; },
    async read(target, offset, length, position) {
      const count = Math.min(shortRead, length);
      target.fill(120, offset, offset + count);
      if (lf >= position && lf < position + count) target[offset + lf - position] = 10;
      reads.push({ start: position, length: count });
      return count;
    },
  };
  const checkpoint: ReverseCheckpoint = { version: 1, jobId: job.jobId, sourceLineage: lineage, ...snapshot,
    pinnedEnd: size, recordEnd: size, scanBefore: size, sourceFence: { start: size, end: size, digest: 'c'.repeat(64) } };
  return { source, snapshot, reads, checkpoint };
}

describe('resumable reverse locating', () => {
  it('does not return a late located result when cancellation arrives during durable publication', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-locate-')); directories.push(directory);
    const input = fixture(10), controller = new AbortController(), write = frames.writeWindowFrame;
    vi.spyOn(frames, 'writeWindowFrame').mockImplementation(async (...args) => { await write(...args); controller.abort(); });
    await expect(advanceReverseIndexTask(directory, job, input.source, input.checkpoint, createWindowBudget(), controller.signal)).rejects.toThrow();
    // Valid progress survives, but the cancelled request cannot publish into the current window.
    expect(await loadReverseIndexTask(directory, job, createWindowBudget())).toMatchObject({ kind: 'hit', position: { kind: 'located' } });
  });

  it('reads one tail block beyond 32-bit offsets without reading the prefix', async () => {
    const input = fixture(20 * 1024 ** 3, 20 * 1024 ** 3 - 19);
    const budget = createWindowBudget();
    const step = await stepReverseIndex(input.source, input.checkpoint, budget);
    expect(step).toMatchObject({ kind: 'located', range: { start: input.snapshot.size - 18, end: input.snapshot.size } });
    expect(input.reads).toEqual([{ start: input.snapshot.size - BLOCK, length: BLOCK }]);
    expect(budget.counters.sourceBytes).toBe(BLOCK);
  });

  it('advances even without LF and resumes from the persisted scan boundary', async () => {
    const input = fixture(BLOCK * 3 + 17, 16);
    const first = await stepReverseIndex(input.source, input.checkpoint, createWindowBudget());
    expect(first.kind).toBe('scanning');
    if (first.kind !== 'scanning') throw new Error('Expected scanning');
    const restored = JSON.parse(JSON.stringify(first.checkpoint)) as ReverseCheckpoint;
    const second = await stepReverseIndex(input.source, restored, createWindowBudget());
    expect(second.kind).toBe('scanning');
    expect(input.reads.map(read => read.start)).toEqual([BLOCK * 2 + 17, BLOCK + 17]);
    expect(second).not.toHaveProperty('role');
  });

  it('finds BOF without inventing a newline or treating escaped newline as LF', async () => {
    const input = fixture(10);
    expect(await stepReverseIndex(input.source, input.checkpoint, createWindowBudget()))
      .toMatchObject({ kind: 'located', range: { start: 0, end: 10 } });
  });

  it('accepts D pre-trimmed recordEnd and avoids the final terminating LF', async () => {
    const input = fixture(20, 19);
    input.checkpoint.recordEnd = 18; input.checkpoint.scanBefore = 18;
    expect(await stepReverseIndex(input.source, input.checkpoint, createWindowBudget()))
      .toMatchObject({ kind: 'located', range: { start: 0, end: 18 } });
  });

  it('accounts short reads, including bytes before I/O failure or cancellation', async () => {
    const input = fixture(100, -1, 7), budget = createWindowBudget();
    const originalRead = input.source.read;
    input.source.read = async (...args) => { if (input.reads.length) throw new Error('I/O failed'); return originalRead(...args); };
    await expect(stepReverseIndex(input.source, input.checkpoint, budget)).rejects.toThrow('I/O failed');
    expect(budget.counters.sourceBytes).toBe(7);
    const controller = new AbortController(), cancelled = fixture(100, -1, 7), counted = createWindowBudget();
    const read = cancelled.source.read;
    cancelled.source.read = async (...args) => { const count = await read(...args); controller.abort(); return count; };
    await expect(stepReverseIndex(cancelled.source, cancelled.checkpoint, counted, controller.signal)).rejects.toThrow();
    expect(counted.counters.sourceBytes).toBe(7);
  });

  it('reserves before I/O and uses the request budget across steps', async () => {
    const input = fixture(BLOCK * 10), budget = createWindowBudget();
    let checkpoint = input.checkpoint;
    for (let index = 0; index < 8; index++) {
      const step = await stepReverseIndex(input.source, checkpoint, budget);
      if (step.kind !== 'scanning') throw new Error('Expected scanning');
      checkpoint = step.checkpoint;
    }
    await expect(stepReverseIndex(input.source, checkpoint, budget)).rejects.toBeInstanceOf(WindowBudgetExceeded);
    expect(input.reads).toHaveLength(8);
  });

  it('resets for replacement, rewrite, truncation and append without reading old ranges', async () => {
    for (const change of [{ sourceInstance: 'new' }, { snapshotRevision: 'new' }, { size: 1 }, { size: 1000 }]) {
      const input = fixture(100); Object.assign(input.snapshot, change);
      expect(await stepReverseIndex(input.source, input.checkpoint, createWindowBudget())).toEqual({ kind: 'reset', reason: 'source_changed' });
      expect(input.reads).toEqual([]);
    }
  });

  it('publishes one durable fixed-address checkpoint and reloads it after two restarts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-locate-')); directories.push(directory);
    const input = fixture(BLOCK * 3 + 17, 16);
    let checkpoint = input.checkpoint;
    for (let restart = 0; restart < 2; restart++) {
      const step = await advanceReverseIndexTask(directory, job, input.source, checkpoint, createWindowBudget());
      expect(step.kind).toBe('scanning');
      const loaded = await loadReverseIndexTask(directory, job, createWindowBudget());
      if (loaded.kind !== 'hit') throw new Error('Expected checkpoint');
      checkpoint = loaded.position.checkpoint;
    }
    expect(checkpoint.scanBefore).toBe(BLOCK + 17);
    const step = await advanceReverseIndexTask(directory, job, input.source, checkpoint, createWindowBudget());
    if (step.kind !== 'scanning') throw new Error('Expected boundary block');
    const located = await advanceReverseIndexTask(directory, job, input.source, step.checkpoint, createWindowBudget());
    expect(located).toMatchObject({ kind: 'located', range: { start: 17, end: input.snapshot.size } });
    expect(input.reads.map(read => read.start)).toEqual([BLOCK * 2 + 17, BLOCK + 17, 17, 0]);
  });

  it('rejects corrupt or differently bound checkpoints instead of successful empty history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gugu-locate-')); directories.push(directory);
    const input = fixture(10);
    await saveReverseIndexTask(directory, job, { kind: 'scanning', checkpoint: input.checkpoint });
    const path = join(directory, windowFrameName({ ...job, kind: 'head', cursor: `reverse:${job.jobId}` }));
    const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
    expect(await loadReverseIndexTask(directory, job, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'checksum' });
    expect(await loadReverseIndexTask(directory, { ...job, jobId: 'different' }, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
  });
});
