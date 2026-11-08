import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { advanceCommitContainerIndex as advance, readIndexedCommitContainerPage as read, type CommitContainerIndex } from './window-commit-container-index';
import { writeWindowCommitSource } from './window-commit-source';

const directories: string[] = [], binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
afterEach(async () => { vi.restoreAllMocks(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(value: unknown = Array.from({ length: 200 }, (_, i) => ({ id: `real:${i}` }))) {
  const directory = await mkdtemp(join(tmpdir(), 'commit-index-')); directories.push(directory);
  const prefix = `{"padding":"${'p'.repeat(70000)}","items":`, serialized = `${prefix}${JSON.stringify(value)}}`;
  const source = await writeWindowCommitSource(directory, binding, serialized);
  const index: CommitContainerIndex = { buildId: 'generation-A', kind: 'array', range: { start: Buffer.byteLength(prefix), end: Buffer.byteLength(serialized) - 1 } };
  return { directory, binding, source, index, serialized: Buffer.from(serialized) };
}
const key = (c: Awaited<ReturnType<typeof fixture>>, ordinal: number | null) => {
  const id = createHash('sha256').update(JSON.stringify([c.index.buildId, c.index.kind, c.index.range.start, c.index.range.end])).digest('hex');
  return { ...binding, kind: ordinal === null ? 'head' as const : 'projection' as const, cursor: `container:${id}:${ordinal === null ? 'head' : ordinal}` };
};
async function complete(c: Awaited<ReturnType<typeof fixture>>) {
  for (let i = 0; i < 300; i++) {
    const result = await advance(c, createWindowBudget());
    expect(result.kind).not.toBe('rebuild');
    if (result.kind === 'complete') return result.head;
  }
  throw new Error('Index did not complete');
}
async function prototype(path: string) {
  const file = await open(path, 'r');
  try { return Object.getPrototypeOf(file) as FileHandle; } finally { await file.close(); }
}

describe('durable bounded container indexes', () => {
  it('reopens a completed build and seeks a late page without reading predecessors or the raw prefix', async () => {
    const c = await fixture(), h = await complete(c), pageOrdinal = h.pages - 2;
    expect(h.pages).toBeGreaterThan(5); expect(h.state.ordinal).toBe(200);
    const proto = await prototype(join(c.directory, windowFrameName(key(c, null)))), original = proto.read;
    let actual = 0; const reads = vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, buffer: Uint8Array, offset: number, length: number, at: number) {
      const result = await (Reflect.apply(original, this, [buffer, offset, length, at]) as ReturnType<typeof original>);
      actual += result.bytesRead; return result;
    }) as typeof original);
    const budget = createWindowBudget(), result = await read(c, pageOrdinal, budget);
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('Missing late page');
    expect(reads).toHaveBeenCalledTimes(2); expect(actual).toBe(budget.counters.indexBytes);
    expect(budget.counters.sourceBytes).toBe(0);
    expect(result.page.members.map(m => JSON.parse(c.serialized.subarray(m.range.start, m.range.end).toString()) as unknown))
      .toEqual(result.page.members.map(m => ({ id: `real:${m.ordinal}` })));
    expect((await read(c, h.pages, createWindowBudget())).kind).toBe('end');
  });

  it('recovers a durable page whose checkpoint write was interrupted without duplicating members', async () => {
    const c = await fixture(), first = await advance(c, createWindowBudget());
    expect(first.kind).toBe('progress');
    await rm(join(c.directory, windowFrameName(key(c, null))));
    const recovered = await advance(c, createWindowBudget()); expect(recovered).toEqual(first);
    const h = await complete(c); expect(h.state.ordinal).toBe(200);
  });

  it('resumes a giant nested value from its durable nonzero checkpoint after discarding all in-memory state', async () => {
    const c = await fixture(['x'.repeat(130000), { id: 'last' }]);
    const first = await advance(c, createWindowBudget());
    if (first.kind !== 'progress') throw new Error('Expected partial progress');
    expect(first.head.pages).toBe(0); expect(first.head.state.lex.offset).toBeGreaterThan(c.index.range.start + 16000);
    const proto = await prototype(join(c.directory, windowFrameName(key(c, null)))), original = proto.read, raw: number[] = [];
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, buffer: Uint8Array, offset: number, length: number, at: number) {
      if (length > 4096) raw.push(at);
      return Reflect.apply(original, this, [buffer, offset, length, at]) as ReturnType<typeof original>;
    }) as typeof original);
    await advance({ ...c, index: structuredClone(c.index) }, createWindowBudget());
    expect(raw[0]).toBe(Math.floor(first.head.state.lex.offset / 16384) * c.source.stride);
    expect((await complete(c)).state.ordinal).toBe(2);
  });

  it('requests a new build at the same known anchor for damaged/version-mismatched metadata', async () => {
    const c = await fixture(), h = await complete(c);
    await writeWindowFrame(c.directory, key(c, null), Buffer.from(JSON.stringify({ ...h, version: 2 })));
    expect(await advance(c, createWindowBudget())).toEqual({ kind: 'rebuild', anchor: c.index.range });
    const fresh = { ...c, index: { ...c.index, buildId: 'generation-B' } };
    expect((await complete(fresh)).state.ordinal).toBe(200);
    await writeFile(join(fresh.directory, windowFrameName(key(fresh, 0))), 'broken frame');
    expect((await read(fresh, 0, createWindowBudget())).kind).toBe('rebuild');
    expect((await read(c, 0, createWindowBudget())).kind).toBe('rebuild');
  });

  it('leaves the last checkpoint unchanged when cancelled after page durability, then resumes identically', async () => {
    const c = await fixture(), proto = await prototype(join(c.directory, windowFrameName({ ...binding, kind: 'head', cursor: 'raw:head' })));
    const original = proto.sync, controller = new AbortController();
    vi.spyOn(proto, 'sync').mockImplementationOnce(async function(this: FileHandle) { await original.call(this); controller.abort(); });
    await expect(advance(c, createWindowBudget(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const result = await advance(c, createWindowBudget()); expect(result.kind).toBe('progress');
    expect((await complete(c)).state.ordinal).toBe(200);
  });

  it('propagates real I/O and budget failures instead of classifying them as a rebuild', async () => {
    const c = await fixture(); await advance(c, createWindowBudget());
    const proto = await prototype(join(c.directory, windowFrameName(key(c, null))));
    vi.spyOn(proto, 'read').mockRejectedValueOnce(Object.assign(new Error('injected read failure'), { code: 'EIO' }));
    await expect(advance(c, createWindowBudget())).rejects.toMatchObject({ code: 'EIO' });
    vi.restoreAllMocks(); const budget = createWindowBudget(); await budget.read('indexBytes', 65536, async () => 65536);
    await expect(advance(c, budget)).rejects.toThrow('budget exhausted');
    expect(budget.counters.indexBytes).toBe(65536);
  });

  it('rechecks the source after checkpoint durability and never reports a changed empty source as successful end', async () => {
    const c = await fixture([]), proto = await prototype(join(c.directory, windowFrameName({ ...binding, kind: 'head', cursor: 'raw:head' })));
    const sourcePath = join(c.directory, `${windowFrameName({ ...binding, kind: 'segment', cursor: 'raw:data' })}.source`), original = proto.sync;
    vi.spyOn(proto, 'sync').mockImplementationOnce(async function(this: FileHandle) {
      await original.call(this); await writeFile(sourcePath, 'changed after source read');
    });
    await expect(advance(c, createWindowBudget())).rejects.toThrow('source changed');
    vi.restoreAllMocks();
    await expect(read(c, 0, createWindowBudget())).rejects.toThrow('source changed');
  });
});
