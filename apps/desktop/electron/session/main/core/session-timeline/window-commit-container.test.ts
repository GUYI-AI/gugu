import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createCommitContainerState as create, readCommitContainerPage as read, resumeCommitContainerState as resume,
  type CommitContainerState, type CommitContainerMember } from './window-commit-container';
import { writeWindowCommitSource } from './window-commit-source';

const directories: string[] = [], binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
afterEach(async () => { vi.restoreAllMocks(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(serialized: string) {
  const path = await mkdtemp(join(tmpdir(), 'commit-members-')); directories.push(path);
  const source = await writeWindowCommitSource(path, binding, serialized);
  const blob = join(path, (await readdir(path)).find(name => name.endsWith('.source'))!);
  const bytes = Buffer.from(serialized);
  return { path, source, blob, bytes, decode: (range: { start: number; end: number }) => JSON.parse(bytes.subarray(range.start, range.end).toString()) as unknown };
}
async function collect(f: Awaited<ReturnType<typeof fixture>>, initial: CommitContainerState) {
  let state = initial, steps = 0, indexBytes = 0;
  const members: CommitContainerMember[] = [];
  for (;;) {
    const budget = createWindowBudget(), page = await read(f.path, binding, f.source, state, budget);
    expect(page.members.length).toBeLessThanOrEqual(16);
    expect(budget.counters.indexBytes).toBeLessThanOrEqual(2 * f.source.stride);
    expect(budget.counters.sourceBytes).toBe(0);
    indexBytes += budget.counters.indexBytes;
    expect(JSON.stringify(page.state).length).toBeLessThan(1200);
    expect(page.state.lex.offset).toBeGreaterThan(state.lex.offset);
    members.push(...page.members); state = resume(JSON.parse(JSON.stringify(page.state)), f.source);
    if (page.complete) return { members, state, steps: steps + 1, indexBytes };
    expect(++steps).toBeLessThan(500);
  }
}

describe('bounded canonical container member ranges', () => {
  it('returns exact byte ranges and values without retaining nested metadata, payload or child lists', async () => {
    const value = { '中文😀"': 'é\\\n', id: 'real-item-id', empty: '', n: -123.5, b: true, z: null,
      object: { text: 'body', children: [{ value: [false, {}] }] }, array: ['x', 2, null], tail: 'last' };
    const f = await fixture(JSON.stringify(value)), before = create(f.source, { start: 0, end: f.source.bytes }, 'object');
    const result = await collect(f, before);
    expect(result.members.map(member => f.decode(member.key!))).toEqual(Object.keys(value));
    expect(result.members.map(member => f.decode(member.range))).toEqual(Object.values(value));
    expect(result.members.map(member => member.ordinal)).toEqual(Object.keys(value).map((_, i) => i));
    expect(result.members.filter(member => member.kind === 'primitive').map(member => member.value)).toEqual([-123.5, true, null]);
    expect(before.lex.offset).toBe(0); expect(before.ordinal).toBe(0);
  });

  it('yields constant checkpoints through giant keys, strings and deeply nested opaque values', async () => {
    const key = 'k'.repeat(70000), serialized = `{"${key}":"${'x'.repeat(130000)}","nested":${'['.repeat(10000)}0${']'.repeat(10000)}}`;
    const f = await fixture(serialized), result = await collect(f, create(f.source, { start: 0, end: f.source.bytes }, 'object'));
    expect(result.steps).toBeGreaterThan(5); expect(result.members).toHaveLength(2);
    expect(result.members[0].range.end - result.members[0].range.start).toBe(130002);
    expect(result.members[1].kind).toBe('array'); expect(JSON.stringify(result.members).length).toBeLessThan(400);
  });

  it('opens a non-first array directly and pages hundreds of children in order with no prefix reads', async () => {
    const values = Array.from({ length: 200 }, (_, i) => ({ id: `real:${i}`, text: `😀${i}` }));
    const f = await fixture(JSON.stringify({ padding: 'p'.repeat(160000), items: values }));
    const root = await collect(f, create(f.source, { start: 0, end: f.source.bytes }, 'object'));
    const items = root.members.find(member => f.decode(member.key!) === 'items')!;
    const file = await open(f.blob, 'r'), proto = Object.getPrototypeOf(file) as FileHandle; await file.close();
    const original = proto.read, positions: number[] = []; let actual = 0;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      positions.push(position);
      const result = await (Reflect.apply(original, this, [target, offset, length, position]) as ReturnType<typeof original>);
      actual += result.bytesRead; return result;
    }) as typeof original);
    const result = await collect(f, create(f.source, items.range, 'array'));
    expect(result.members.map(member => f.decode(member.range))).toEqual(values);
    expect(result.members.map(member => member.ordinal)).toEqual(values.map((_, i) => i));
    expect(result.members.every(member => member.key === null)).toBe(true);
    expect(Math.min(...positions)).toBe(Math.floor(items.range.start / 16384) * f.source.stride);
    expect(actual).toBeGreaterThan(0); expect(actual).toBe(result.indexBytes);
  });

  it.each(['{}', '[]'])('finishes an empty container: %s', async serialized => {
    const f = await fixture(serialized), state = create(f.source, { start: 0, end: f.source.bytes }, serialized === '{}' ? 'object' : 'array');
    const result = await collect(f, state); expect(result.members).toEqual([]); expect(result.state.phase).toBe('done');
    expect((await read(f.path, binding, f.source, result.state, createWindowBudget())).complete).toBe(true);
  });

  it.each(['{"a":}', '{"a" 1}', '{"a":1,}', '[1,]', '[1 2]', '{"a":[]]'])('rejects malformed immediate container grammar: %s', async serialized => {
    const f = await fixture(serialized), state = create(f.source, { start: 0, end: f.source.bytes }, serialized.startsWith('{') ? 'object' : 'array');
    await expect(collect(f, state)).rejects.toThrow();
  });

  it('rejects foreign/corrupt checkpoints and cancellation before physical I/O', async () => {
    const f = await fixture('{"a":[1,2]}'), state = create(f.source, { start: 0, end: f.source.bytes }, 'object');
    for (const corrupt of [{ ...state, version: 2 }, { ...state, sourceHash: 'f'.repeat(64) }, { ...state, ordinal: 100 },
      { ...state, phase: 'nested', pending: { start: 1, depth: 0, kind: 'array' } }, { ...state, key: { start: -1, end: 5 } }])
      expect(() => resume(corrupt, f.source)).toThrow();
    const controller = new AbortController(); controller.abort(); const budget = createWindowBudget();
    await expect(read(f.path, binding, f.source, state, budget, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.indexBytes).toBe(0);
  });
});
