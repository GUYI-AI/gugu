import { describe, expect, it } from 'vitest';
import { readBytePage, WINDOW_FRAME_BYTES } from './byte-page';
import { createWindowBudget, WindowBudgetExceeded, WINDOW_LIMITS } from './read-budget';
import type { SourceSnapshot, WindowByteSource } from './types';

function source(size = 20 * 1024 ** 3 + 17) {
  let snapshot: SourceSnapshot = { sourceId: 'source', sourceInstance: 'inode', snapshotRevision: 'revision', size };
  const reads: Array<{ position: number; length: number }> = [];
  const api: WindowByteSource = { snapshot: async () => ({ ...snapshot }),
    async read(target, offset, length, position) {
      reads.push({ position, length });
      target.fill(65, offset, offset + length);
      return length;
    } };
  return { api, reads, change(next: Partial<SourceSnapshot>) { snapshot = { ...snapshot, ...next }; } };
}

describe('bounded source windows', () => {
  it('seeks beyond signed 32-bit offsets without reading the poison prefix', async () => {
    const input = source();
    const budget = createWindowBudget();
    const result = await readBytePage(input.api, { budget });
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('Expected page');
    expect(input.reads).toEqual([{ position: 20 * 1024 ** 3 + 17 - WINDOW_FRAME_BYTES, length: WINDOW_FRAME_BYTES }]);
    expect(result.bytes).toHaveLength(WINDOW_FRAME_BYTES);
    expect(budget.counters.sourceBytes).toBe(WINDOW_FRAME_BYTES);
    for (let page = 1, cursor = result.older; page < 8 && cursor; page++) {
      const older = await readBytePage(input.api, { budget, cursor });
      if (older.kind !== 'page') throw new Error('Expected older page');
      cursor = older.older;
    }
    expect(budget.counters.sourceBytes).toBe(WINDOW_LIMITS.sourceBytes);
    await expect(readBytePage(input.api, { budget })).rejects.toBeInstanceOf(WindowBudgetExceeded);
    expect(input.reads).toHaveLength(8);
  });

  it('rejects cross-source and changed-revision cursors before I/O', async () => {
    const input = source();
    const result = await readBytePage(input.api, { budget: createWindowBudget() });
    if (result.kind !== 'page' || !result.older) throw new Error('Expected cursor');
    for (const change of [{ sourceId: 'other' }, { sourceInstance: 'replacement' }, { snapshotRevision: 'rewrite' }]) {
      expect(await readBytePage(input.api, { budget: createWindowBudget(), cursor: { ...result.older, ...change } }))
        .toEqual({ kind: 'reset', reason: 'source_changed' });
    }
    expect(input.reads).toHaveLength(1);
  });

  it('reports cancellation and preserves actual short-read accounting', async () => {
    const input = source();
    const abort = new AbortController();
    input.api.read = async () => { abort.abort(); return 7; };
    const budget = createWindowBudget();
    await expect(readBytePage(input.api, { budget, signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.sourceBytes).toBe(7);
  });

  it('counts completed reads before a later I/O error, and never returns an empty success', async () => {
    const input = source();
    let calls = 0;
    input.api.read = async () => { if (calls++ === 0) return 7; throw new Error('disk failure'); };
    const budget = createWindowBudget();
    await expect(readBytePage(input.api, { budget })).rejects.toThrow('disk failure');
    expect(budget.counters.sourceBytes).toBe(7);
  });

  it('invalidates bytes changed during the read and handles zero-byte reads', async () => {
    const input = source();
    input.api.read = async (_target, _offset, length) => { input.change({ snapshotRevision: 'changed' }); return length; };
    expect(await readBytePage(input.api, { budget: createWindowBudget() })).toEqual({ kind: 'reset', reason: 'source_changed' });
    input.api.read = async () => 0;
    expect(await readBytePage(input.api, { budget: createWindowBudget() })).toEqual({ kind: 'reset', reason: 'source_changed' });
    input.change({ size: 0 });
    const empty = await readBytePage(input.api, { budget: createWindowBudget() });
    expect(empty.kind === 'page' && empty.older === null && empty.bytes.length === 0).toBe(true);
  });

  it('reserves concurrent reads before calling either allocation callback', async () => {
    const budget = createWindowBudget({ ...WINDOW_LIMITS, indexBytes: 8 });
    let release!: (count: number) => void;
    const first = budget.read('indexBytes', 8, () => new Promise(resolve => { release = resolve; }));
    let called = false;
    await expect(budget.read('indexBytes', 1, async () => { called = true; return 1; })).rejects.toBeInstanceOf(WindowBudgetExceeded);
    expect(called).toBe(false);
    release(3);
    await first;
    await budget.read('indexBytes', 5, async () => 5);
    expect(budget.counters.indexBytes).toBe(8);
    budget.charge('examinedRecords', WINDOW_LIMITS.examinedRecords);
    expect(() => budget.charge('examinedRecords', 1)).toThrow(WindowBudgetExceeded);
  });

  it('rejects invalid sizes and read counts before publishing bytes', async () => {
    for (const size of [-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const input = source(size);
      await expect(readBytePage(input.api, { budget: createWindowBudget() })).rejects.toThrow('Invalid source size');
      expect(input.reads).toHaveLength(0);
    }
    for (const count of [-1, 0.5, WINDOW_FRAME_BYTES + 1]) {
      const input = source();
      input.api.read = async () => count;
      await expect(readBytePage(input.api, { budget: createWindowBudget() })).rejects.toThrow('Invalid read length');
    }
  });
});
