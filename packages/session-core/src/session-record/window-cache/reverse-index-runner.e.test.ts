import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openWindowByteSource } from './file-source';
import * as byteSources from './file-source';
import { createWindowBudget } from './read-budget';
import { advanceReverseIndexTask, loadReverseIndexTask } from './record-locators';
import { createReverseIndexScheduler } from './reverse-index-runner';
import type { ReverseCheckpoint, WindowIoCounters } from './types';

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

it.each(['cancel', 'read_error'] as const)('reports actual partial source IO in finally after %s without publishing progress', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-reverse-meter-')), path = join(directory, 'source.jsonl');
  await writeFile(path, '{}\n' + 'x'.repeat(150_000));
  const source = await openWindowByteSource(path), snapshot = await source.snapshot(); await source.close();
  const checkpoint: ReverseCheckpoint = { version: 1, jobId: 'meter', sourceId: snapshot.sourceId,
    sourceInstance: snapshot.sourceInstance, sourceLineage: 'b'.repeat(64), snapshotRevision: snapshot.snapshotRevision,
    pinnedEnd: snapshot.size, recordEnd: snapshot.size, scanBefore: snapshot.size,
    sourceFence: { start: snapshot.size, end: snapshot.size, digest: 'c'.repeat(64) } };
  const scope = 'a'.repeat(64), onStep = vi.fn(), onLocated = vi.fn(), reads: Readonly<WindowIoCounters>[] = [], failures: string[] = [];
  let resolve!: () => void, reject!: (error: unknown) => void;
  const reported = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  let resolveFailure!: () => void;
  const failed = new Promise<void>(yes => { resolveFailure = yes; });
  const scheduler = createReverseIndexScheduler({ onStep, onLocated,
    onRead(jobId, io) { expect(jobId).toBe('meter'); reads.push(io); resolve(); },
    onFailure(error, jobId) { failures.push(jobId); if (mode === 'read_error') resolveFailure(); else reject(error); } });
  const realOpen = byteSources.openWindowByteSource;
  const open = vi.spyOn(byteSources, 'openWindowByteSource').mockImplementation(async path => {
    const input = await realOpen(path); let completedReads = 0;
    return { ...input, async read(target, offset, length, position) {
      if (mode === 'read_error' && completedReads) throw new Error('Injected read failure');
      const count = await input.read(target, offset, mode === 'read_error' ? Math.min(32768, length) : length, position);
      completedReads += 1;
      if (mode === 'cancel') void scheduler.pause();
      return count;
    } };
  });
  try {
    scheduler.schedule(path, checkpoint, directory, scope); await reported;
    if (mode === 'read_error') await failed;
    await scheduler.pause();
    expect(reads).toHaveLength(1); expect(reads[0].sourceBytes).toBe(mode === 'cancel' ? 65536 : 32768);
    expect(failures).toEqual(mode === 'cancel' ? [] : ['meter']);
    expect(onStep).not.toHaveBeenCalled(); expect(onLocated).not.toHaveBeenCalled();
    expect(await loadReverseIndexTask(directory, { scope, sourceLineage: checkpoint.sourceLineage, decoderVersion: 1, jobId: 'meter' }, createWindowBudget()))
      .toMatchObject({ kind: 'miss' });
  } finally { open.mockRestore(); await scheduler.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it('attributes one background read failure to its job while the next selected job still locates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-reverse-owner-')), bad = join(directory, 'bad.jsonl'), good = join(directory, 'good.jsonl');
  await Promise.all([bad, good].map(path => writeFile(path, '{}\n' + 'x'.repeat(70_000))));
  async function checkpointFor(path: string, jobId: string): Promise<ReverseCheckpoint> {
    const source = await openWindowByteSource(path), snapshot = await source.snapshot(); await source.close();
    return { version: 1, jobId, sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance,
      sourceLineage: 'b'.repeat(64), snapshotRevision: snapshot.snapshotRevision, pinnedEnd: snapshot.size,
      recordEnd: snapshot.size, scanBefore: snapshot.size, sourceFence: { start: snapshot.size, end: snapshot.size, digest: 'c'.repeat(64) } };
  }
  const badCheckpoint = await checkpointFor(bad, 'failed-job'), goodCheckpoint = await checkpointFor(good, 'healthy-job'), scope = 'a'.repeat(64);
  const failures: string[] = [], located: string[] = [], metered: { jobId: string; bytes: number }[] = [];
  let resolve!: () => void, reject!: (error: unknown) => void;
  const completed = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const scheduler = createReverseIndexScheduler({
    onFailure(error, jobId) {
      failures.push(jobId); if (jobId !== 'failed-job') { reject(error); return; }
      scheduler.schedule(good, goodCheckpoint, directory, scope);
    },
    onLocated(jobId) { located.push(jobId); resolve(); },
    onRead(jobId, io) { metered.push({ jobId, bytes: io.sourceBytes }); },
  });
  const realOpen = byteSources.openWindowByteSource;
  const open = vi.spyOn(byteSources, 'openWindowByteSource').mockImplementation(async path => {
    const source = await realOpen(path); let read = false;
    return { ...source, async read(target, offset, length, position) {
      if (path !== bad) return source.read(target, offset, length, position);
      if (read) throw new Error('Background source read failed');
      read = true; return source.read(target, offset, Math.min(length, 32768), position);
    } };
  });
  try {
    scheduler.schedule(bad, badCheckpoint, directory, scope); await completed; await scheduler.pause();
    expect(failures).toEqual(['failed-job']); expect(located).toEqual(['healthy-job']);
    expect(metered.filter(read => read.jobId === 'failed-job')).toEqual([{ jobId: 'failed-job', bytes: 32768 }]);
    expect(metered.filter(read => read.jobId === 'healthy-job').reduce((sum, read) => sum + read.bytes, 0)).toBe(70_003);
  } finally { open.mockRestore(); await scheduler.dispose(); await rm(directory, { recursive: true, force: true }); }
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
