import { describe, expect, it } from 'vitest';
import { readIndexedBodyPage, readJsonStringBodyPage, type BodyPageIo } from './body-reader';
import { createWindowBudget } from './read-budget';
import { BODY_CHUNK_BYTES } from './types';
import type { WindowBodyRef, WindowByteSource } from './types';

function bodyFixture(encoded: string, prefix = 0) {
  const bytes = new TextEncoder().encode(encoded);
  const snapshot = { sourceId: 's', sourceInstance: 'i', snapshotRevision: 'r', size: prefix + bytes.length };
  const reads: number[] = [];
  const source: WindowByteSource = {
    async snapshot() { return snapshot; },
    async read(target, offset, length, position) {
      reads.push(position);
      if (position < prefix) throw new Error('Body head was reread');
      target.set(bytes.subarray(position - prefix, position - prefix + length), offset);
      return length;
    },
  };
  return { source, snapshot, reads, end: snapshot.size };
}

describe('seekable JSON string body pages', () => {
  it('decodes escapes, Unicode and surrogate pairs from a nonzero raw checkpoint', async () => {
    const fixture = bodyFixture('abc\\n\\t\\"\\\\\\/\\u4e2d\\ud83d\\ude00"},"ignored":true}', 20 * 1024 ** 3);
    const budget = createWindowBudget();
    const page = await readJsonStringBodyPage(fixture.source, { ...fixture, position: {
      rawOffset: 20 * 1024 ** 3, decodedOffset: 0 }, maxBytes: 16384, budget });
    if (page.kind !== 'body') throw new Error('Expected body');
    expect(page.text).toBe('abc\n\t"\\/中😀');
    expect(page.complete).toBe(true);
    expect(page.next.decodedOffset).toBe(new TextEncoder().encode(page.text).length);
    expect(budget.counters.outputBytes).toBe(page.next.decodedOffset);
    expect(fixture.reads).toHaveLength(1);
  });

  it('continues at the saved raw checkpoint without rereading earlier text', async () => {
    const fixture = bodyFixture('中文😀abc"');
    const budget = createWindowBudget();
    const first = await readJsonStringBodyPage(fixture.source, { ...fixture,
      position: { rawOffset: 0, decodedOffset: 0 }, maxBytes: 4, budget });
    if (first.kind !== 'body') throw new Error('Expected body');
    expect(first.text).toBe('中');
    expect(first.next).toEqual({ rawOffset: 3, decodedOffset: 3 });
    const second = await readJsonStringBodyPage(fixture.source, { ...fixture,
      position: first.next, maxBytes: 4, budget });
    if (second.kind !== 'body') throw new Error('Expected body');
    expect(second.text).toBe('文');
    expect(fixture.reads).toEqual([0, 3]);
  });

  it('leaves an escape split at a physical page boundary for the next seek', async () => {
    const fixture = bodyFixture('\\n'.repeat(32767) + '\\u4e2d"');
    const page = await readJsonStringBodyPage(fixture.source, { ...fixture,
      position: { rawOffset: 0, decodedOffset: 0 }, maxBytes: 32768, budget: createWindowBudget() });
    if (page.kind !== 'body') throw new Error('Expected body');
    const atBoundary = await readJsonStringBodyPage(fixture.source, { ...fixture,
      position: { rawOffset: 65534, decodedOffset: 65534 }, maxBytes: 4, budget: createWindowBudget() });
    if (atBoundary.kind !== 'body') throw new Error('Expected body');
    expect(atBoundary.text).toBe('中');
    expect(atBoundary.complete).toBe(true);
    expect(page.text).toBe('\n'.repeat(32767));
    expect(page.next.rawOffset).toBe(65534);
  });

  it.each(['bad\\q"', 'bad\\uZZZZ"', 'bad\n"', 'unterminated', 'abc\\', 'abc\\u123'])('rejects malformed string %j', async text => {
    const fixture = bodyFixture(text);
    await expect(readJsonStringBodyPage(fixture.source, { ...fixture,
      position: { rawOffset: 0, decodedOffset: 0 }, maxBytes: 16384, budget: createWindowBudget() })).rejects.toThrow(SyntaxError);
  });

  it('charges short reads before cancellation and never publishes partial text', async () => {
    const fixture = bodyFixture('abcdef"');
    const budget = createWindowBudget();
    const abort = new AbortController();
    fixture.source.read = async (target, offset) => { target[offset] = 97; abort.abort(); return 1; };
    await expect(readJsonStringBodyPage(fixture.source, { ...fixture,
      position: { rawOffset: 0, decodedOffset: 0 }, maxBytes: 16384, budget, signal: abort.signal })).rejects.toThrow();
    expect(budget.counters.sourceBytes).toBe(1);
    expect(budget.counters.outputBytes).toBe(0);
  });
});

describe('indexed decoded body pages', () => {
  const body: WindowBodyRef = { version: 1, scope: 'scope', sourceLineage: 'lineage', id: 'body', revision: 'v1',
    owner: { kind: 'canonical', turnId: 'turn', itemId: 'item' },
    turnId: 'turn', itemId: 'item', firstChunk: null, decoderCheckpoint: null, sourceRange: { start: 0, end: 1 }, byteLength: null };
  function indexed(chunks: Map<number, Uint8Array>) {
    const queried: number[] = [];
    const io: BodyPageIo = {
      async descriptor(ref, ordinal, budget) {
        queried.push(ordinal);
        await budget.read('indexBytes', 128, async () => 128);
        const chunk = chunks.get(ordinal);
        return chunk ? { bodyId: ref.id, revision: ref.revision, ordinal, decodedStart: ordinal * BODY_CHUNK_BYTES,
          decodedBytes: chunk.length, content: { id: String(ordinal), offset: 0, length: chunk.length, digest: '' },
          checkpointRef: null, sourceRange: { start: 0, end: 1 } } : null;
      },
      async content(ref, budget) {
        const chunk = chunks.get(Number(ref.id))!;
        await budget.read('indexBytes', chunk.length, async () => chunk.length);
        return chunk;
      },
    };
    return { io, queried };
  }
  it('directly reads page N above 32-bit offsets without earlier descriptors', async () => {
    const ordinal = 1_000_000;
    const { io, queried } = indexed(new Map([[ordinal - 1, new Uint8Array(BODY_CHUNK_BYTES).fill(120)], [ordinal, new Uint8Array(BODY_CHUNK_BYTES).fill(120)]]));
    const result = await readIndexedBodyPage(io, { bodyRef: body, offset: ordinal * BODY_CHUNK_BYTES, maxBytes: 4096, budget: createWindowBudget() });
    expect(queried).toEqual([ordinal, ordinal - 1]);
    expect(result.kind).toBe('body');
    expect(result.io.indexBytes).toBe(2 * (BODY_CHUNK_BYTES + 128));
  });
  it('returns needs_location at an unknown page without reading from the body head', async () => {
    const { io, queried } = indexed(new Map());
    const result = await readIndexedBodyPage(io, { bodyRef: body, offset: 123456, maxBytes: 4096, budget: createWindowBudget() });
    expect(result.kind).toBe('needs_location');
    expect(queried).toEqual([Math.floor(123456 / BODY_CHUNK_BYTES)]);
  });
  it('bounds the worst three-chunk read and preserves UTF-8 at the response boundary', async () => {
    const all = new Uint8Array(4 * BODY_CHUNK_BYTES).fill(120);
    all.set(new TextEncoder().encode('😀'), 3 * BODY_CHUNK_BYTES - 3);
    const chunks = new Map(Array.from({ length: 4 }, (_, n) => [n, all.subarray(n * BODY_CHUNK_BYTES, (n + 1) * BODY_CHUNK_BYTES)]));
    const { io, queried } = indexed(chunks);
    const budget = createWindowBudget();
    const first = await readIndexedBodyPage(io, { bodyRef: body, offset: 2 * BODY_CHUNK_BYTES - 1, maxBytes: 32768, budget });
    if (first.kind !== 'body') throw new Error('Expected body');
    expect(queried).toEqual([1, 2, 0]);
    expect(first.nextOffset).toBe(3 * BODY_CHUNK_BYTES - 3);
    expect(first.text).not.toContain('�');
    expect(budget.counters.indexBytes).toBeLessThan(65536);
    const next = await readIndexedBodyPage(io, { bodyRef: body, offset: first.nextOffset, maxBytes: 4, budget: createWindowBudget() });
    if (next.kind !== 'body') throw new Error('Expected body');
    expect(next.text).toBe('😀');
    expect(next.nextOffset - first.nextOffset).toBe(4);
    expect(first.previousOffset).toBe(BODY_CHUNK_BYTES - 1);
    const previous = await readIndexedBodyPage(io, { bodyRef: body, offset: first.previousOffset!,
      maxBytes: first.offset - first.previousOffset!, budget: createWindowBudget() });
    if (previous.kind !== 'body') throw new Error('Expected previous body page');
    expect(previous.nextOffset).toBe(first.offset);
    expect(previous.text).not.toContain('�');
  });
});
