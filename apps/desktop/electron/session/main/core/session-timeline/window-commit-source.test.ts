import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWindowFrame, windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { readWindowCommitSourceChunk as read, readWindowCommitSourceManifest as manifest, writeWindowCommitSource as write } from './window-commit-source';

const CHUNK = 16384, owned: string[] = [];
const binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
const rootKey = { ...binding, kind: 'head' as const, cursor: 'raw:head' };
const rawKey = (ordinal: number) => ({ ...binding, kind: 'segment' as const, cursor: `raw:${String(ordinal).padStart(16, '0')}` });
afterEach(async () => { vi.restoreAllMocks(); for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'commit-source-')); owned.push(path); return path; }
async function fixture() {
  const path = await directory();
  // Place an astral scalar across the writer's 4096-code-unit slice boundary.
  const text = JSON.stringify({ text: 'x'.repeat(4086) + '😀中\\"'.repeat(24000) });
  const source = await write(path, binding, text);
  return { path, text, source, blob: join(path, (await readdir(path)).find(name => name.endsWith('.source'))!) };
}
async function prototype(path: string) {
  const file = await open(path, 'r');
  try { return Object.getPrototypeOf(file) as FileHandle; } finally { await file.close(); }
}

describe('immutable write-ahead commit source', () => {
  it('durably encodes bounded frames without breaking CJK, emoji or escapes and can reopen without an in-memory offset table', async () => {
    const f = await fixture(), loaded = await manifest(f.path, binding, createWindowBudget());
    expect(loaded).toEqual({ kind: 'hit', source: f.source });
    const chunks: Uint8Array[] = [];
    for (let ordinal = 0; ordinal < f.source.chunks; ordinal++) chunks.push(await read(f.path, binding, f.source, ordinal, createWindowBudget()));
    const actual = Buffer.concat(chunks);
    expect(actual.toString('utf8')).toBe(f.text);
    expect(actual.includes(Buffer.from('�'))).toBe(false);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(f.source.sha256);
    expect((await readdir(f.path)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('point-reads a late chunk only, accounts physical frame bytes, and rejects the fourth shared-budget read before I/O', async () => {
    const f = await fixture(), proto = await prototype(f.blob), original = proto.read;
    const positions: number[] = [];
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      positions.push(position); return (Reflect.apply(original, this, [target, offset, length, position]) as ReturnType<typeof original>);
    }) as typeof original);
    const budget = createWindowBudget();
    const loaded = await manifest(f.path, binding, budget); expect(loaded.kind).toBe('hit'); positions.length = 0;
    for (const ordinal of [5, 6, 7]) await read(f.path, binding, f.source, ordinal, budget);
    expect(positions).toEqual([5, 6, 7].map(n => n * f.source.stride));
    expect(budget.counters.indexBytes).toBeGreaterThan(3 * f.source.stride);
    expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
    const before = budget.counters.indexBytes;
    await expect(read(f.path, binding, f.source, 8, budget)).rejects.toThrow('budget exhausted');
    expect(positions).toHaveLength(3); expect(budget.counters.indexBytes).toBe(before);
  });

  it('does not overwrite an immutable source name and rejects same-size valid-checksum rewrites', async () => {
    const f = await fixture();
    await expect(write(f.path, binding, f.text)).rejects.toMatchObject({ code: 'EEXIST' });
    const packet = encodeWindowFrame(rawKey(0), Buffer.alloc(CHUNK, 122)), file = await open(f.blob, 'r+');
    try { await file.write(packet, 0, packet.length, 0); await file.sync(); } finally { await file.close(); }
    const budget = createWindowBudget();
    await expect(read(f.path, binding, f.source, 0, budget)).rejects.toThrow('source changed');
    expect(budget.counters.indexBytes).toBe(0);
    expect((await readdir(f.path)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('checks the named inode after reading so an open handle cannot validate a replacement', async () => {
    const f = await fixture(), proto = await prototype(f.blob), original = proto.read;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      const result = await (Reflect.apply(original, this, [target, offset, length, position]) as ReturnType<typeof original>);
      await rm(f.blob); await writeFile(f.blob, 'replacement'); return result;
    }) as typeof original);
    const budget = createWindowBudget();
    await expect(read(f.path, binding, f.source, 2, budget)).rejects.toThrow('during read');
    expect(budget.counters.indexBytes).toBe(f.source.stride);
  });

  it('continues short reads and records bytes received before cancellation while closing the actual handle', async () => {
    const f = await fixture(), proto = await prototype(f.blob), original = proto.read, controller = new AbortController();
    let actualStat: (() => Promise<unknown>) | undefined, cancel = false;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      actualStat = () => this.stat();
      const result = await (Reflect.apply(original, this, [target, offset, Math.min(257, length), position]) as ReturnType<typeof original>);
      if (cancel) controller.abort(); return result;
    }) as typeof original);
    const short = createWindowBudget(); expect((await read(f.path, binding, f.source, 1, short)).length).toBe(CHUNK);
    expect(short.counters.indexBytes).toBe(f.source.stride);
    cancel = true; const partial = createWindowBudget();
    await expect(read(f.path, binding, f.source, 2, partial, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(partial.counters.indexBytes).toBe(257);
    await expect(actualStat!()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('retains actual partial I/O on an error and never publishes a root after cancellation at fsync', async () => {
    const f = await fixture(), proto = await prototype(f.blob), original = proto.read;
    let count = 0;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      if (count++) throw Object.assign(new Error('injected I/O'), { code: 'EIO' });
      return (Reflect.apply(original, this, [target, offset, Math.min(17, length), position]) as ReturnType<typeof original>);
    }) as typeof original);
    const budget = createWindowBudget();
    await expect(read(f.path, binding, f.source, 2, budget)).rejects.toMatchObject({ code: 'EIO' });
    expect(budget.counters.indexBytes).toBe(17); vi.restoreAllMocks();
    const path = await directory(), controller = new AbortController(), sync = proto.sync;
    vi.spyOn(proto, 'sync').mockImplementation(async function(this: FileHandle) { await sync.call(this); controller.abort(); });
    await expect(write(path, binding, f.text, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(path)).toEqual([]);
  });

  it('treats malformed root schemas as bounded misses and validates address arithmetic before I/O', async () => {
    const f = await fixture();
    for (const invalid of [{ ...f.source, version: 2 }, { ...f.source, physical: null }, { ...f.source, bytes: Number.MAX_SAFE_INTEGER,
      chunks: Math.ceil(Number.MAX_SAFE_INTEGER / CHUNK) }]) {
      await writeWindowFrame(f.path, rootKey, Buffer.from(JSON.stringify(invalid)));
      const budget = createWindowBudget(); expect((await manifest(f.path, binding, budget)).kind).toBe('miss');
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(4096);
    }
    await writeFile(join(f.path, windowFrameName(rootKey)), 'bad frame');
    expect((await manifest(f.path, binding, createWindowBudget())).kind).toBe('miss');
    const budget = createWindowBudget();
    await expect(read(f.path, binding, f.source, f.source.chunks, budget)).rejects.toThrow('ordinal');
    expect(budget.counters.indexBytes).toBe(0);
  });
});
