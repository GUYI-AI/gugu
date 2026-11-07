import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { TailIdentityStore } from '../tail-identity-store';
import { createTailCommitter, type IdentityWrite } from './append-store';
import { createTailDiskIo } from './append-disk';
import * as frames from './disk-frame';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import type { TailHead } from './types';

it('recovers 16 real two-slot identity revisions and checked frames under one 64 KiB budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gugu-tail-recovery-'));
  const path = join(directory, 'native.jsonl'); await writeFile(path, 'tail');
  const source = await openWindowByteSource(path);
  const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
  const binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
  const key = (kind: 'segment' | 'head', cursor: string) => ({ ...binding, kind, cursor });
  const identities = new TailIdentityStore(join(directory, 'identity'));
  const aliases = (revision: string): IdentityWrite[] => Array.from({ length: 16 }, (_, index) => ({
    scope: binding.scope, lineage: binding.sourceLineage, key: `record:${index}`,
    value: { canonicalId: `canonical:${index}:` + 'c'.repeat(220), revision: revision.repeat(200), projectionRef: 'p'.repeat(200) },
  }));
  try {
    await identities.commitSegment(1, 0, [], aliases('1'), createWindowBudget());
    await frames.writeWindowFrame(directory, key('segment', 'prior'), Buffer.from('{}'));
    const oldHead: TailHead = { format: 'gugu.desktop-tail/1', ...binding, commitSeq: 1, sourceEnd: 0,
      tail: { id: 'prior', offset: 0, length: 2, digest: hash('{}') }, sourceFence: { start: 0, end: 0, digest: hash('') } };
    await frames.writeWindowFrame(directory, key('head', 'current'), Buffer.from(JSON.stringify(oldHead)));
    const makeIo = () => createTailDiskIo({ directory, binding, source,
      sourceInstance: (sourceSnapshot as { sourceInstance: string }).sourceInstance,
      commitIdentity: (seq, published, receipts, writes, budget) => identities.commitSegment(seq, published, receipts, writes, budget) });
    const sourceSnapshot = await source.snapshot();
    const disk = makeIo();
    const interrupted = createTailCommitter({ ...disk, publishHead: async () => { throw new Error('simulated process exit'); } });
    const pending = await interrupted.prepareSegment({ previous: oldHead, sourceRange: { start: 0, end: 4 },
      sourceFence: { start: 0, end: 4, digest: hash('tail') }, projection: new Uint8Array(60 * 1024),
      decoderCheckpoint: new Uint8Array(60 * 1024), writes: { receipts: [], aliases: aliases('2') }, budget: createWindowBudget() });
    await expect(interrupted.commitPreparedSegment(pending, createWindowBudget())).rejects.toThrow('simulated process exit');
    const old = await identities.lookupIdentity(binding.scope, binding.sourceLineage, 'record:0', 1, createWindowBudget());
    expect(old.kind === 'found' && old.value.revision).toBe('1'.repeat(200));
    const reads = vi.spyOn(frames, 'readWindowFrame');
    try {
      const budget = createWindowBudget();
      const result = await createTailCommitter(makeIo()).recoverPending(budget);
      expect(result?.commitSeq).toBe(2);
      // Every counter is charged by actual FileHandle.read calls in A frames and B slots/fences.
      expect(budget.counters.indexBytes).toBeGreaterThan(33_568);
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(64 * 1024);
      expect(budget.counters.sourceBytes).toBe(4);
      expect(reads.mock.calls.map(call => call[1].cursor).every(cursor => ['pending', 'current', pending.writes.id].includes(cursor))).toBe(true);
      expect(reads.mock.calls.some(call => call[1].kind === 'projection' || call[1].kind === 'body')).toBe(false);
      const latest = await identities.lookupIdentity(binding.scope, binding.sourceLineage, 'record:0', 2, createWindowBudget());
      expect(latest.kind === 'found' && latest.value.revision).toBe('2'.repeat(200));
    } finally { reads.mockRestore(); }
  } finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
});
