import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { writeWindowCommitSource } from './window-commit-source';
import { createWindowCommitReader as create } from './window-commit-reader';

const directories: string[] = [], binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
afterEach(async () => { vi.restoreAllMocks(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(text = 'x'.repeat(100000)) {
  const path = await mkdtemp(join(tmpdir(), 'commit-reader-')); directories.push(path);
  const serialized = JSON.stringify({ text }), source = await writeWindowCommitSource(path, binding, serialized);
  const blob = join(path, (await readdir(path)).find(name => name.endsWith('.source'))!);
  const handle = await open(blob, 'r'); const proto = Object.getPrototypeOf(handle) as FileHandle; await handle.close();
  return { path, source, blob, proto, serialized: Buffer.from(serialized) };
}

describe('request-owned bounded commit reader', () => {
  it('shares one physical frame among metadata reads and returns copies that cannot mutate the cache', async () => {
    const f = await fixture(), budget = createWindowBudget(), original = f.proto.read;
    let actual = 0;
    const reads = vi.spyOn(f.proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, at: number) {
      const result = await (Reflect.apply(original, this, [target, offset, length, at]) as ReturnType<typeof original>);
      actual += result.bytesRead; return result;
    }) as typeof original);
    const reader = create(f.path, binding, f.source, budget);
    try {
      const bytes = await reader.bytes(0, 20); bytes.fill(122);
      for (let at = 0; at < 32; at++) expect(await reader.bytes(at, 4)).toEqual(new Uint8Array(f.serialized.subarray(at, at + 4)));
      expect(reads).toHaveBeenCalledTimes(1); expect(actual).toBe(f.source.stride);
      expect(budget.counters.indexBytes).toBe(actual); expect(budget.counters.sourceBytes).toBe(0);
    } finally { reader.close(); }
  });

  it('retains only two LRU frames and rejects a fourth physical read before I/O under the shared budget', async () => {
    const f = await fixture(), budget = createWindowBudget(), reads = vi.spyOn(f.proto, 'read'), reader = create(f.path, binding, f.source, budget);
    try {
      for (const ordinal of [0, 1, 0, 2]) await reader.bytes(ordinal * 16384, 4);
      expect(reads).toHaveBeenCalledTimes(3);
      await expect(reader.bytes(16384, 4)).rejects.toThrow('budget exhausted');
      expect(reads).toHaveBeenCalledTimes(3); expect(budget.counters.indexBytes).toBe(3 * f.source.stride);
    } finally { reader.close(); }
  });

  it('pins the original physical identity even when the caller mutates its manifest after a cache fill', async () => {
    const f = await fixture(), reader = create(f.path, binding, f.source, createWindowBudget());
    try {
      await reader.bytes(0, 4);
      const file = await open(f.blob, 'r+'); try { await file.write(Buffer.from('z'), 0, 1, 0); await file.sync(); } finally { await file.close(); }
      const changed = await stat(f.blob, { bigint: true });
      f.source.physical = { dev: String(changed.dev), ino: String(changed.ino), mtimeNs: String(changed.mtimeNs), ctimeNs: String(changed.ctimeNs) };
      await expect(reader.bytes(0, 4)).rejects.toThrow('source changed');
    } finally { reader.close(); }
  });

  it('never carries cached bytes into a new request or a different source', async () => {
    const a = await fixture('first'), b = await fixture('second'), first = create(a.path, binding, a.source, createWindowBudget());
    await first.bytes(0, 4); first.close(); await expect(first.bytes(0, 4)).rejects.toMatchObject({ name: 'AbortError' });
    const budget = createWindowBudget(), second = create(b.path, binding, b.source, budget);
    try {
      expect(await second.bytes(0, b.serialized.length)).toEqual(new Uint8Array(b.serialized));
      expect(budget.counters.indexBytes).toBeGreaterThan(0);
    } finally { second.close(); }
  });

  it('forbids concurrent use without interrupting the accepted operation', async () => {
    const f = await fixture(), reader = create(f.path, binding, f.source, createWindowBudget());
    try {
      const accepted = reader.bytes(0, 4);
      await expect(reader.bytes(4, 4)).rejects.toThrow('Concurrent');
      expect(await accepted).toEqual(new Uint8Array(f.serialized.subarray(0, 4)));
    } finally { reader.close(); }
  });

  it('cancels an actual short read via close, records its received bytes and closes the file', async () => {
    const f = await fixture(), budget = createWindowBudget(), reader = create(f.path, binding, f.source, budget), original = f.proto.read;
    let actualStat: (() => Promise<unknown>) | undefined;
    vi.spyOn(f.proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, at: number) {
      actualStat = () => this.stat();
      const result = await (Reflect.apply(original, this, [target, offset, Math.min(137, length), at]) as ReturnType<typeof original>);
      reader.close(); return result;
    }) as typeof original);
    await expect(reader.bytes(0, 4)).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.indexBytes).toBe(137); await expect(actualStat!()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('honors external cancellation on cached hits and rejects invalid spans before I/O', async () => {
    const f = await fixture(), controller = new AbortController(), budget = createWindowBudget();
    const reader = create(f.path, binding, f.source, budget, controller.signal);
    try {
      await expect(reader.bytes(-1, 4)).rejects.toThrow('span'); expect(budget.counters.indexBytes).toBe(0);
      await reader.bytes(0, 4); controller.abort();
      await expect(reader.bytes(0, 4)).rejects.toMatchObject({ name: 'AbortError' });
      expect(budget.counters.indexBytes).toBe(f.source.stride);
    } finally { reader.close(); }
  });

  it('snapshots the accepted string range and cursor before awaiting physical I/O', async () => {
    const f = await fixture('original'), reader = create(f.path, binding, f.source, createWindowBudget());
    const range = { start: 9, end: f.serialized.length - 1 }, position = { rawOffset: 9, decodedOffset: 0 };
    try {
      const accepted = reader.string(range, position, 4);
      range.end = 1; position.rawOffset = 0; position.decodedOffset = 100;
      expect(await accepted).toMatchObject({ text: 'orig', next: { rawOffset: 13, decodedOffset: 4 }, complete: false });
    } finally { reader.close(); }
  });
});
