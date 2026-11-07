import { describe, expect, it } from 'vitest';
import { readJsonlWindow } from './jsonl-window';
import { createWindowBudget } from './read-budget';
import type { WindowByteSource } from './types';

function fixture(text: string, prefix = 0) {
  const data = new TextEncoder().encode(text);
  const reads: Array<{ position: number; length: number }> = [];
  const source: WindowByteSource = {
    async snapshot() { return { sourceId: 's', sourceInstance: 'i', snapshotRevision: 'r', size: prefix + data.length }; },
    async read(target, offset, length, position) {
      reads.push({ position, length });
      if (position < prefix) throw new Error('Poison prefix was read');
      target.set(data.subarray(position - prefix, position - prefix + length), offset);
      return length;
    },
  };
  return { source, reads };
}

describe('JSONL suffix windows', () => {
  it('keeps absolute byte anchors and reads only one page above 32-bit offsets', async () => {
    const prefix = 20 * 1024 ** 3;
    const tail = '\n{"id":1}\n{"id":2}\n';
    const suffix = 'x'.repeat(65536 - tail.length) + tail;
    const { source, reads } = fixture(suffix, prefix);
    const budget = createWindowBudget();
    const result = await readJsonlWindow(source, { budget, limit: 2 });
    expect(result.kind).toBe('records');
    if (result.kind !== 'records') throw new Error('Expected records');
    expect(result.records.map(r => new TextDecoder().decode(r.bytes))).toEqual(['{"id":2}', '{"id":1}']);
    expect(result.records[0].range.start).toBe(prefix + suffix.lastIndexOf('{'));
    expect(reads).toHaveLength(1);
    expect(reads[0].position).toBeGreaterThan(2 ** 31);
    expect(budget.counters.sourceBytes).toBeLessThanOrEqual(65536);
  });

  it.each(['\n', '\r\n', ''])('does not invent an empty EOF record for terminator %j', async terminator => {
    const { source } = fixture(`{"text":"中文\\n😀"}${terminator}`);
    const result = await readJsonlWindow(source, { budget: createWindowBudget() });
    if (result.kind !== 'records') throw new Error('Expected records');
    expect(result.records).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(result.records[0].bytes))).toEqual({ text: '中文\n😀' });
    expect(result.older).toBeNull();
    expect(result.headFragment).toBeNull();
  });

  it('pages without skipping a record or reading a prefix to count ordinals', async () => {
    const { source } = fixture('{"id":1}\r\n\r\n{"id":2}\r\n{"id":3}\r\n');
    const budget = createWindowBudget();
    const first = await readJsonlWindow(source, { budget, limit: 1 });
    if (first.kind !== 'records' || !first.older) throw new Error('Expected continuation');
    const older = await readJsonlWindow(source, { budget, cursor: first.older });
    if (older.kind !== 'records') throw new Error('Expected records');
    expect(older.records.map(r => JSON.parse(new TextDecoder().decode(r.bytes)).id)).toEqual([2, 1]);
    expect(older.older).toBeNull();
    expect(budget.counters.examinedRecords).toBe(3);
  });

  it('returns an unknown start for a giant final record without parsing it', async () => {
    const { source, reads } = fixture('x'.repeat(65536), 5 * 1024 ** 3);
    const budget = createWindowBudget();
    const result = await readJsonlWindow(source, { budget });
    if (result.kind !== 'pending_record') throw new Error('Expected explicit pending record');
    expect(result.records).toEqual([]);
    expect(result.headFragment).toEqual({ recordEnd: 5 * 1024 ** 3 + 65536, scanBefore: 5 * 1024 ** 3 });
    expect(result.older).toBeNull();
    expect(reads).toHaveLength(1);
    expect(budget.counters.decodedBytes).toBe(0);
  });

  it('rejects cancellation and changed snapshots without returning stale records', async () => {
    const { source } = fixture('{"id":1}\n');
    const abort = new AbortController();
    abort.abort();
    await expect(readJsonlWindow(source, { budget: createWindowBudget(), signal: abort.signal })).rejects.toThrow();
    let revision = 0;
    source.snapshot = async () => ({ sourceId: 's', sourceInstance: 'i', snapshotRevision: String(revision++), size: 9 });
    expect(await readJsonlWindow(source, { budget: createWindowBudget() })).toEqual({ kind: 'reset', reason: 'source_changed' });
  });

  it('retains already located records beside a cross-page head fragment', async () => {
    const { source } = fixture('x'.repeat(65536) + '\n{"id":2}\n', 2 ** 32);
    const result = await readJsonlWindow(source, { budget: createWindowBudget() });
    if (result.kind !== 'pending_record') throw new Error('Expected explicit pending record');
    expect(result.records).toHaveLength(1);
    expect(result.headFragment).not.toBeNull();
    expect(result.older).toBeNull();
  });

  it('a returned continuation advances or explicitly blocks on an unknown start', async () => {
    const { source } = fixture('x'.repeat(65536), 20 * 1024 ** 3);
    const budget = createWindowBudget();
    const first = await readJsonlWindow(source, { budget });
    if (first.kind === 'reset') throw new Error('Unexpected reset');
    expect(first.kind).toBe('pending_record');
    expect(first.older).toBeNull();
    expect(first.headFragment!.scanBefore).toBeLessThan(first.headFragment!.recordEnd);
  });

  it.each(['', '\n', '\r\n', '\n\n'])('proves BOF for empty records %j', async text => {
    const { source } = fixture(text);
    const result = await readJsonlWindow(source, { budget: createWindowBudget() });
    if (result.kind !== 'records') throw new Error('Expected records');
    expect(result.records).toEqual([]);
    expect(result.older).toBeNull();
  });
});
