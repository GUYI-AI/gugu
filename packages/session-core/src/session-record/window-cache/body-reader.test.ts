import { describe, expect, it } from 'vitest';
import { readJsonStringBodyPage } from './body-reader';
import { createWindowBudget } from './read-budget';
import type { WindowByteSource } from './types';

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
      position: { rawOffset: 0, decodedOffset: 0 }, maxBytes: 60 * 1024, budget: createWindowBudget() });
    if (page.kind !== 'body') throw new Error('Expected body');
    const atBoundary = await readJsonStringBodyPage(fixture.source, { ...fixture,
      position: { rawOffset: 65534, decodedOffset: 65534 }, maxBytes: 4, budget: createWindowBudget() });
    if (atBoundary.kind !== 'body') throw new Error('Expected body');
    expect(atBoundary.text).toBe('中');
    expect(atBoundary.complete).toBe(true);
    expect(page.text).toBe('\n'.repeat(32767));
    expect(page.next.rawOffset).toBe(65534);
  });

  it.each(['bad\\q"', 'bad\\uZZZZ"', 'bad\n"', 'unterminated'])('rejects malformed string %j', async text => {
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
