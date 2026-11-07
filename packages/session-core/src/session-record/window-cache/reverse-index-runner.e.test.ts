import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { loadReverseIndexTask } from './record-locators';
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
  const reached = Promise.withResolvers<void>();
  const scheduler = createReverseIndexScheduler({ onFailure: reached.reject,
    onStep(_cp, io) { expect(foreground).toBe(true); reads.push(io.sourceBytes); },
    onLocated(ticket, range) { expect(ticket).toBe('background'); expect(range).toEqual({ start: 3, end: snapshot.size }); reached.resolve(); } });
  try {
    scheduler.schedule(path, checkpoint, directory, scope);
    foreground = true;
    await reached.promise;
    await scheduler.pause();
    expect(reads).toHaveLength(3); expect(Math.max(...reads)).toBeLessThanOrEqual(64 * 1024);
    expect(await loadReverseIndexTask(directory, { scope, sourceLineage: lineage, decoderVersion: 1, jobId: 'background' }, createWindowBudget()))
      .toMatchObject({ kind: 'hit', position: { kind: 'located', range: { start: 3, end: snapshot.size } } });
  } finally { await scheduler.dispose(); await rm(directory, { recursive: true, force: true }); }
});
