import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskBodyPageIo, readIndexedBodyPage, writeDecodedBodyChunk } from './body-reader';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { BODY_CHUNK_BYTES, type WindowBodyRef } from './types';

const owned: string[] = [];
afterEach(async () => { for (const directory of owned.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'window-body-')); owned.push(root);
  const directory = join(root, 'cache'); await mkdir(directory);
  const path = join(root, 'source.jsonl');
  const text = 'x'.repeat(BODY_CHUNK_BYTES - 1) + '😀中文' + 'z'.repeat(4 * BODY_CHUNK_BYTES);
  const encoded = new TextEncoder().encode(text);
  await writeFile(path, JSON.stringify({ text }) + '\n');
  const source = await openWindowByteSource(path), snapshot = await source.snapshot();
  const body: WindowBodyRef = { version: 1, scope: 'a'.repeat(64), sourceLineage: snapshot.sourceInstance,
    id: 'body', revision: snapshot.snapshotRevision, owner: { kind: 'fragment', fragmentKey: 'fragment' },
    firstChunk: null, decoderCheckpoint: null, sourceRange: { start: 0, end: snapshot.size }, byteLength: encoded.length };
  const validate = async () => (await source.snapshot()).snapshotRevision === body.revision;
  const range = { start: 0, end: snapshot.size };
  for (let start = 0, ordinal = 0; start < encoded.length; start += BODY_CHUNK_BYTES, ordinal += 1)
    await writeDecodedBodyChunk(directory, body, ordinal, encoded.subarray(start, start + BODY_CHUNK_BYTES), range, createWindowBudget());
  return { root, directory, path, text, encoded, body, source, range, validate };
}

describe('durable decoded body pages', () => {
  it('reads real frames and navigates after all page-local state is discarded', async () => {
    const f = await fixture();
    try {
      const read = (offset: number, maxBytes = 32768) => readIndexedBodyPage(createDiskBodyPageIo(f.directory, f.validate),
        { bodyRef: f.body, offset, maxBytes, budget: createWindowBudget() });
      const first = await read(0); if (first.kind !== 'body') throw new Error('Expected first body page');
      const second = await read(first.nextOffset); if (second.kind !== 'body') throw new Error('Expected second body page');
      const third = await read(second.nextOffset); if (third.kind !== 'body') throw new Error('Expected third body page');
      expect(third.io.indexBytes).toBeLessThanOrEqual(65536);
      expect(third.previousOffset).not.toBeNull();
      const previous = await read(third.previousOffset!, third.offset - third.previousOffset!);
      if (previous.kind !== 'body') throw new Error('Expected previous body page');
      expect(previous.nextOffset).toBe(third.offset);
      const next = await read(previous.nextOffset);
      if (next.kind !== 'body') throw new Error('Expected next body page');
      expect(next.text).toBe(third.text);
      expect(new TextEncoder().encode(first.text + second.text + third.text)).toEqual(f.encoded.subarray(0, third.nextOffset));
    } finally { await f.source.close(); }
  });
  it('retries an identical chunk and rejects both conflicting content and stale native revisions', async () => {
    const f = await fixture();
    try {
      await writeDecodedBodyChunk(f.directory, f.body, 0, f.encoded.subarray(0, BODY_CHUNK_BYTES), f.range, createWindowBudget());
      await expect(writeDecodedBodyChunk(f.directory, f.body, 0, new Uint8Array(BODY_CHUNK_BYTES).fill(121), f.range, createWindowBudget())).rejects.toThrow('Conflicting');
      await writeFile(f.path, JSON.stringify({ text: 'rewritten' }) + '\n');
      const budget = createWindowBudget();
      await expect(readIndexedBodyPage(createDiskBodyPageIo(f.directory, f.validate), { bodyRef: f.body, offset: 0, maxBytes: 16384, budget })).rejects.toThrow('revision changed');
      expect(budget.counters.outputBytes).toBe(0);
    } finally { await f.source.close(); }
  });
});
