import { mkdtemp, readdir, rm, open, readFile, writeFile, truncate, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TailIdentityStore, type IdentityBudget, type IdentityWrite } from './tail-identity-store';

function budget(limit = 64 * 1024) {
  let bytes = 0;
  return {
    get bytes() { return bytes; },
    async read(_kind: 'indexBytes', size: number, operation: () => Promise<number>) {
      if (size > limit - bytes) throw new Error('index_budget');
      const actual = await operation(); bytes += actual; return actual;
    },
    charge() {},
  } satisfies IdentityBudget & { readonly bytes: number };
}
const value = (revision = 'v1') => ({ canonicalId: 'stored:turn:s7', revision, projectionRef: `frame:${revision}` });
const write = (revision = 'v1', key = 'native-uuid'): IdentityWrite => ({ scope: 'conversation', lineage: 'branch', key, value: value(revision) });
describe('bounded disk identity index', () => {
  let directory: string, root: string, store: TailIdentityStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tail-identity-')); root = join(directory, 'index');
    store = new TailIdentityStore(root);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });
  const lookup = (store: TailIdentityStore, commit: number, meter = budget()) => store.lookupIdentity('conversation', 'branch', 'native-uuid', commit, meter);
  async function dataFile() {
    const shard = (await readdir(root)).find(name => name.length === 2)!;
    return join(root, shard, (await readdir(join(root, shard))).find(name => name.endsWith('.gidx'))!);
  }
  it('separates receipts, identities, scopes and lineages without reading absent keys', async () => {
    await store.commitSegment(1, 0, [write()], [write()], budget());
    expect(await lookup(new TailIdentityStore(root), 1)).toEqual({ kind: 'found', value: value() });
    expect(await store.lookupReceipt('conversation', 'branch', 'native-uuid', 1, budget())).toEqual({ kind: 'found', value: value() });
    const meter = budget();
    expect(await store.lookupIdentity('another', 'branch', 'native-uuid', 1, meter)).toEqual({ kind: 'absent' });
    expect(await store.lookupIdentity('conversation', 'fork', 'native-uuid', 1, meter)).toEqual({ kind: 'absent' });
    expect(meter.bytes).toBe(0);
  });
  it('keeps future receipts invisible and revisions pinned to a published head', async () => {
    await store.commitSegment(1, 0, [], [write()], budget());
    await store.commitSegment(2, 1, [write('v2')], [write('v2')], budget());
    expect(await store.lookupReceipt('conversation', 'branch', 'native-uuid', 1, budget())).toEqual({ kind: 'absent' });
    expect(await lookup(store, 1)).toEqual({ kind: 'found', value: value() });
    expect(await lookup(store, 2)).toEqual({ kind: 'found', value: value('v2') });
    await store.commitSegment(2, 1, [write('v2')], [write('v2')], budget());
    expect(await lookup(store, 2)).toEqual({ kind: 'found', value: value('v2') });
    await expect(store.commitSegment(2, 1, [], [write('different')], budget())).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.commitSegment(4, 2, [], [], budget())).rejects.toMatchObject({ code: 'invalid' });
  });
  it('never turns exhausted budgets, corruption or I/O failures into absence', async () => {
    await store.commitSegment(1, 0, [], [write()], budget());
    await expect(lookup(store, 1, budget(1023))).rejects.toThrow('index_budget');
    const path = await dataFile(), bytes = await readFile(path); bytes[100] ^= 1; await writeFile(path, bytes);
    await expect(lookup(store, 1)).rejects.toMatchObject({ code: 'corrupt' });
    await expect(new TailIdentityStore(path).lookupIdentity('conversation', 'branch', 'native-uuid', 1, budget())).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
  it('keeps a committed prefix readable across unpublished short tails and exact retries', async () => {
    await store.commitSegment(1, 0, [], [write()], budget());
    const path = await dataFile(), fence = await readFile(`${path}.fence`);
    await store.commitSegment(2, 1, [], [write('v2')], budget());
    const complete = await readFile(path);
    for (const partial of [4, 400]) {
      await writeFile(`${path}.fence`, fence); await writeFile(path, complete.subarray(0, 1024 + partial));
      expect(await lookup(store, 1)).toEqual({ kind: 'found', value: value() });
    }
    await store.commitSegment(2, 1, [], [write('v2')], budget());
    expect(await lookup(store, 1)).toEqual({ kind: 'found', value: value() });
    expect(await lookup(store, 2)).toEqual({ kind: 'found', value: value('v2') });
    await truncate(path, 1024 + 400);
    await expect(lookup(store, 1)).rejects.toMatchObject({ code: 'corrupt' });
  });
  it('meters actual short reads, completes short writes and syncs before return', async () => {
    const sample = await open(join(directory, 'probe'), 'w+');
    const prototype = Object.getPrototypeOf(sample) as FileHandle;
    const read = prototype.read, writeBytes = prototype.write;
    const readSpy = vi.spyOn(prototype, 'read').mockImplementation(function (this: FileHandle, ...args: unknown[]) {
      if (typeof args[2] === 'number') args[2] = Math.min(args[2], 31);
      return Reflect.apply(read, this, args);
    });
    vi.spyOn(prototype, 'write').mockImplementation(function (this: FileHandle, ...args: unknown[]) {
      if (typeof args[2] === 'number') args[2] = Math.min(args[2], 7);
      return Reflect.apply(writeBytes, this, args);
    });
    const sync = vi.spyOn(prototype, 'sync');
    try {
      await store.commitSegment(1, 0, [], [write()], budget());
      const meter = budget(); expect(await lookup(store, 1, meter)).toEqual({ kind: 'found', value: value() });
      expect(meter.bytes).toBe(1024 + 48); expect(readSpy.mock.calls.length).toBeGreaterThan(32); expect(sync).toHaveBeenCalled();
    } finally { await sample.close(); }
  });
  it('survives an interrupted real commit after the first four new slot bytes', async () => {
    await store.commitSegment(1, 0, [], [write()], budget());
    const sample = await open(await dataFile(), 'r+'), prototype = Object.getPrototypeOf(sample) as FileHandle;
    const original = prototype.write; let interrupt = true;
    const spy = vi.spyOn(prototype, 'write').mockImplementation(async function (this: FileHandle, ...args: unknown[]) {
      if (interrupt && Buffer.isBuffer(args[0]) && args[0].length === 1024) {
        interrupt = false; args[2] = 4; await Reflect.apply(original, this, args); throw new Error('power_loss');
      }
      return Reflect.apply(original, this, args);
    });
    try {
      await expect(store.commitSegment(2, 1, [], [write('v2')], budget())).rejects.toThrow('power_loss');
      expect(await lookup(store, 1)).toEqual({ kind: 'found', value: value() });
      spy.mockRestore(); await store.commitSegment(2, 1, [], [write('v2')], budget());
      expect(await lookup(store, 2)).toEqual({ kind: 'found', value: value('v2') });
    } finally { await sample.close(); }
  });
  it('preserves canonical IDs and bounds batches before encoding', async () => {
    await store.commitSegment(1, 0, [], [write()], budget());
    await expect(store.commitSegment(2, 1, [], [{ ...write(), value: { ...value(), canonicalId: 'different' } }], budget())).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.commitSegment(2, 1, Array.from({ length: 25 }, () => write()), [], budget())).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.commitSegment(2, 1, [], [write('x'.repeat(257))], budget())).rejects.toMatchObject({ code: 'invalid' });
  });
  it('pins the durable fence before a concurrent append changes data size', async () => {
    await store.commitSegment(1, 0, [], [write()], budget());
    const sample = await open(await dataFile(), 'r'), prototype = Object.getPrototypeOf(sample) as FileHandle;
    const original = prototype.stat; let append = true;
    const spy = vi.spyOn(prototype, 'stat').mockImplementation(async function (this: FileHandle) {
      const stats = await Reflect.apply(original, this, []);
      if (append && stats.size === 1024) { append = false; await store.commitSegment(2, 1, [], [write('v2')], budget()); }
      return stats;
    });
    try { expect(await lookup(store, 1)).toEqual({ kind: 'found', value: value() }); }
    finally { spy.mockRestore(); await sample.close(); }
    expect(await lookup(store, 2)).toEqual({ kind: 'found', value: value('v2') });
  });
  it('latest lookup reads one slot after many unrelated keys and revisions', async () => {
    for (let commit = 1; commit <= 20; commit++) await store.commitSegment(commit, commit - 1, [], [write(`v${commit}`), write('other', `key${commit}`)], budget());
    const meter = budget(); expect(await lookup(store, 20, meter)).toEqual({ kind: 'found', value: value('v20') });
    expect(meter.bytes).toBe(1024 + 48);
    expect(await lookup(store, 7)).toEqual({ kind: 'found', value: value('v7') });
  });
  it('can retry a maximum segment after a mid-write budget failure within one shared budget', async () => {
    const writes = Array.from({ length: 24 }, (_, key) => write('v1', `key${key}`));
    await store.commitSegment(1, 0, [], writes, budget());
    const revised = writes.map(entry => ({ ...entry, value: value('v2') }));
    await expect(store.commitSegment(2, 1, [], revised, budget(32 + 3 * 1024))).rejects.toThrow('index_budget');
    const meter = budget(); await store.commitSegment(2, 1, [], revised, meter);
    expect(meter.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(await store.lookupIdentity('conversation', 'branch', 'key0', 1, budget())).toEqual({ kind: 'found', value: value() });
    expect(await store.lookupIdentity('conversation', 'branch', 'key23', 2, budget())).toEqual({ kind: 'found', value: value('v2') });
  });
});
