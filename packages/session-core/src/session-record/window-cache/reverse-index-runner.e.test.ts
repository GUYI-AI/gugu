import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { advanceReverseIndexTask, loadReverseIndexTask } from './record-locators';
import { createReverseIndexScheduler } from './reverse-index-runner';
import type { ReverseCheckpoint } from './types';

it('runs locating in durable one-block steps and yields to foreground before reading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-reverse-runner-'));
  const path = join(directory, 'source.jsonl');
  await writeFile(path, '{}\n' + 'x'.repeat(150_000));
  const source = await openWindowByteSource(path), snapshot = await source.snapshot(); await source.close();
  const scope = 'a'.repeat(64), lineage = 'b'.repeat(64), reads: number[] = [];
  const checkpoint: ReverseCheckpoint = { version: 1, jobId: 'background', sourceId: snapshot.sourceId,
    sourceInstance: snapshot.sourceInstance, sourceLineage: lineage, snapshotRevision: snapshot.snapshotRevision,
    pinnedEnd: snapshot.size, recordEnd: snapshot.size, scanBefore: snapshot.size,
    sourceFence: { start: snapshot.size, end: snapshot.size, digest: 'c'.repeat(64) } };
  let foreground = false;
  let resolveReached: () => void = () => {};
  let rejectReached: (error: unknown) => void = () => {};
  const reached = new Promise<void>((resolve, reject) => { resolveReached = resolve; rejectReached = reject; });
  const scheduler = createReverseIndexScheduler({ onFailure: rejectReached,
    onStep(_cp, io) { expect(foreground).toBe(true); reads.push(io.sourceBytes); },
    onLocated(ticket, range) { expect(ticket).toBe('background'); expect(range).toEqual({ start: 3, end: snapshot.size }); resolveReached(); } });
  try {
    scheduler.schedule(path, checkpoint, directory, scope);
    foreground = true;
    await reached;
    await scheduler.pause();
    expect(reads).toHaveLength(3); expect(Math.max(...reads)).toBeLessThanOrEqual(64 * 1024);
    expect(await loadReverseIndexTask(directory, { scope, sourceLineage: lineage, decoderVersion: 1, jobId: 'background' }, createWindowBudget()))
      .toMatchObject({ kind: 'hit', position: { kind: 'located', range: { start: 3, end: snapshot.size } } });
  } finally { await scheduler.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('reopens the durable checkpoint before continuing an old scheduling ticket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-reverse-resume-')), path = join(directory, 'source.jsonl');
  await writeFile(path, '{}\n' + 'x'.repeat(150_000));
  const source = await openWindowByteSource(path), snapshot = await source.snapshot(), scope = 'a'.repeat(64), lineage = 'b'.repeat(64);
  const checkpoint: ReverseCheckpoint = { version: 1, jobId: 'restart', sourceId: snapshot.sourceId,
    sourceInstance: snapshot.sourceInstance, sourceLineage: lineage, snapshotRevision: snapshot.snapshotRevision,
    pinnedEnd: snapshot.size, recordEnd: snapshot.size, scanBefore: snapshot.size,
    sourceFence: { start: snapshot.size, end: snapshot.size, digest: 'c'.repeat(64) } };
  await advanceReverseIndexTask(directory, { scope, sourceLineage: lineage, decoderVersion: 1, jobId: 'restart' }, source, checkpoint, createWindowBudget());
  await source.close(); // The next scheduler receives the original ticket, not an in-memory updated offset.
  const reads: number[] = [];
  async function finish() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const located = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const scheduler = createReverseIndexScheduler({ onFailure: reject, onStep(_cp, io) { reads.push(io.sourceBytes); },
      onLocated(_ticket, range) { expect(range.start).toBe(3); resolve(); } });
    try { scheduler.schedule(path, checkpoint, directory, scope); await located; }
    finally { await scheduler.dispose(); }
  }
  try {
    await finish(); expect(reads).toEqual([65536, snapshot.size - 2 * 65536]);
    reads.length = 0; await finish(); expect(reads).toEqual([0]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
