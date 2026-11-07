import { describe, expect, it, vi } from 'vitest';
import { createRecentReader } from './recent-reader';
import { createWindowBudget } from './read-budget';
import type { WindowByteSource, WindowReadRequest } from './types';

function setup(prefix = 20 * 1024 ** 3, giant = false, pinned = false) {
  const row = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n';
  const suffix = '\n' + row('older') + row('latest');
  let bytes = new TextEncoder().encode(giant ? 'x'.repeat(65536) : 'x'.repeat(2 * 65536 - suffix.length) + suffix);
  let revision = 'r1';
  const reads: Array<{ position: number; length: number }> = [];
  const source: WindowByteSource = {
    async snapshot() { return { sourceId: 'source', sourceInstance: 'instance', snapshotRevision: revision, size: prefix + bytes.length }; },
    async read(target, offset, length, position) {
      if (position < prefix) throw new Error('Poison prefix was read');
      reads.push({ position, length }); target.set(bytes.subarray(position - prefix, position - prefix + length), offset); return length;
    },
  };
  const schedulePending = vi.fn(async () => {}), close = vi.fn(async () => {});
  const readEnd = pinned ? prefix + bytes.length : undefined;
  const reader = createRecentReader({ openSource: async () => ({ source, sourceLineage: 'lineage', readEnd, close }), schedulePending,
    body: { descriptor: async () => null, content: async () => { throw new Error('Unexpected body read'); } } });
  const request = (): WindowReadRequest => ({ locator: { harness: 'codex', providerSessionId: 'session', roots: [] },
    conversationId: 'session', cacheDirectory: '/unused', scope: 'scope', conversationScope: 'conversation', branchLineage: 'branch', limit: 1, budget: createWindowBudget() });
  return { reader, request, reads, schedulePending, close, append() {
    const tail = new TextEncoder().encode(row('new'));
    const next = new Uint8Array(bytes.length + tail.length); next.set(bytes); next.set(tail, bytes.length); bytes = next; revision = 'r2';
  } };
}

describe('recent source windows', () => {
  it('seeks a 20 GiB source and pages with stable byte-anchored fragments', async () => {
    const { reader, request, reads, close } = setup();
    const latest = await reader.openRecent(request());
    if (latest.kind !== 'page' || !latest.olderCursor) throw new Error('Expected recent page');
    expect(latest.turns).toEqual([]);
    expect(latest.sourceFragments?.[0]).toMatchObject({ text: 'latest', ownership: 'unresolved' });
    const older = await reader.readOlder({ ...request(), cursor: latest.olderCursor });
    if (older.kind !== 'page') throw new Error('Expected older page');
    expect(older.sourceFragments?.[0].text).toBe('older');
    expect(reads).toHaveLength(2);
    expect(reads.every(read => read.position > 2 ** 31 && read.length <= 65536)).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('does not change an existing fragment key when another record is appended', async () => {
    const { reader, request, append } = setup();
    const first = await reader.openRecent(request());
    if (first.kind !== 'page') throw new Error('Expected page');
    append();
    const next = await reader.openRecent({ ...request(), limit: 2 });
    if (next.kind !== 'page') throw new Error('Expected page');
    expect(next.sourceFragments?.find(fragment => fragment.text === 'latest')?.key).toBe(first.sourceFragments?.[0].key);
  });
  it('keeps a real opening byte boundary while the physical source grows and changes revision', async () => {
    const { reader, request, append, reads } = setup(undefined, false, true);
    const first = await reader.openRecent(request());
    if (first.kind !== 'page') throw new Error('Expected page');
    const openingEnd = reads[0].position + reads[0].length;
    append();
    const next = await reader.openRecent({ ...request(), limit: 2 });
    if (next.kind !== 'page') throw new Error('Expected bounded historical page');
    expect(next.sourceFragments?.map(fragment => fragment.text)).toEqual(['older', 'latest']);
    expect(next.snapshotRevision).toBe('r2');
    expect(reads.every(read => read.position + read.length <= openingEnd)).toBe(true);
  });
  it('publishes a separate locating ticket without inventing a record or canonical turn', async () => {
    const { reader, request, schedulePending } = setup(undefined, true);
    const result = await reader.openRecent(request());
    if (result.kind !== 'continuation') throw new Error('Expected pending continuation');
    expect(result.sourceFragments).toEqual([]); expect(result.turns).toEqual([]);
    expect(result.pendingLongRecords).toHaveLength(1); expect(result.moreBefore).toBe('unknown');
    expect(result.olderCursor).toBeNull(); expect(schedulePending).toHaveBeenCalledOnce();
    expect(result.io.sourceBytes).toBe(65536);
  });
});
