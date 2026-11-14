import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { readWindowCommitStringPage as read } from './window-commit-body';
import { writeWindowCommitSource } from './window-commit-source';

const CHUNK = 16384, directories: string[] = [];
const binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
afterEach(async () => { vi.restoreAllMocks(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture(raw: string, prefix = '{"text":') {
  const path = await mkdtemp(join(tmpdir(), 'commit-body-')); directories.push(path);
  const source = await writeWindowCommitSource(path, binding, `${prefix}${raw}}`);
  const range = { start: Buffer.byteLength(prefix) + 1, end: Buffer.byteLength(prefix + raw) };
  const blob = join(path, (await readdir(path)).find(name => name.endsWith('.source'))!);
  return { path, source, range, blob, position: { rawOffset: range.start, decodedOffset: 0 } };
}
async function prototype(path: string) {
  const file = await open(path, 'r');
  try { return Object.getPrototypeOf(file) as FileHandle; } finally { await file.close(); }
}

describe('bounded immutable commit string pages', () => {
  it('decodes escaped UTF-8 across physical frames and resumes from every returned byte checkpoint', async () => {
    const expected = '中文😀\\\n"'.repeat(6000), f = await fixture(JSON.stringify(expected));
    let position = f.position, text = '', count = 0;
    for (;;) {
      const budget = createWindowBudget(), page = await read(f.path, binding, f.source, { ...f, position, maxBytes: 4096, budget });
      expect(page.next.rawOffset).toBeGreaterThan(position.rawOffset);
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(4096);
      expect(budget.counters.sourceBytes).toBe(0);
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(2 * f.source.stride);
      expect(budget.counters.decodedBytes).toBe(Buffer.byteLength(page.text));
      text += page.text; position = page.next; count++;
      if (page.complete) break;
      expect(count).toBeLessThan(100);
    }
    expect(text).toBe(expected); expect(position).toEqual({ rawOffset: f.range.end, decodedOffset: Buffer.byteLength(expected) });
  });

  it.each(['""', '"\\uD83D\\uDE00x"', '"😀x"', JSON.stringify('\\"\nx')])('preserves empty bodies and scalar/escape boundaries: %s', async raw => {
    const padding = 'p'.repeat(CHUNK - 18), prefix = `{"padding":"${padding}","text":`;
    const f = await fixture(raw, prefix), parts: string[] = [];
    let position = f.position;
    for (let n = 0; n < 20; n++) {
      const page = await read(f.path, binding, f.source, { ...f, position, maxBytes: 4, budget: createWindowBudget() });
      parts.push(page.text); position = page.next;
      if (page.complete) { expect(parts.join('')).toBe(JSON.parse(raw)); return; }
      expect(page.next.rawOffset).toBeGreaterThan(f.position.rawOffset);
    }
    throw new Error('String paging made no progress');
  });

  it('point-reads a late string without its prefix and accounts each physical byte exactly once', async () => {
    const f = await fixture(JSON.stringify('late😀'.repeat(8000)), `{"ignored":"${'p'.repeat(400000)}","text":`);
    const proto = await prototype(f.blob), original = proto.read, positions: number[] = [];
    let actual = 0;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      positions.push(position);
      const result = await (Reflect.apply(original, this, [target, offset, length, position]) as ReturnType<typeof original>);
      actual += result.bytesRead; return result;
    }) as typeof original);
    const budget = createWindowBudget(), page = await read(f.path, binding, f.source, { ...f, maxBytes: 4096, budget });
    const first = Math.floor(f.range.start / CHUNK);
    expect(page.text.startsWith('late😀')).toBe(true);
    expect(positions).toEqual([first * f.source.stride, (first + 1) * f.source.stride]);
    expect(budget.counters.indexBytes).toBe(actual); expect(actual).toBe(2 * f.source.stride);
    expect(budget.counters.sourceBytes).toBe(0);
  });

  it('rejects malformed ranges and exhausted admission before reading, retaining prior shared counters', async () => {
    const f = await fixture(JSON.stringify('x'.repeat(CHUNK * 3))), proto = await prototype(f.blob);
    const reads = vi.spyOn(proto, 'read'), budget = createWindowBudget();
    await expect(read(f.path, binding, f.source, { ...f, range: { start: 0, end: 2 }, maxBytes: 4, budget })).rejects.toThrow('position');
    await expect(read(f.path, binding, f.source, { ...f, position: { rawOffset: f.range.end, decodedOffset: 0 }, maxBytes: 4, budget })).rejects.toThrow('position');
    await expect(read(f.path, binding, f.source, { ...f, position: { ...f.position, decodedOffset: Number.MAX_SAFE_INTEGER }, maxBytes: 4, budget })).rejects.toThrow('position');
    await budget.read('indexBytes', 65536, async () => 65536);
    await expect(read(f.path, binding, f.source, { ...f, maxBytes: 4, budget })).rejects.toThrow('budget exhausted');
    expect(reads).not.toHaveBeenCalled(); expect(budget.counters.indexBytes).toBe(65536);
    const partial = createWindowBudget();
    await partial.read('indexBytes', 65536 - f.source.stride, async () => 65536 - f.source.stride);
    await expect(read(f.path, binding, f.source, { ...f, maxBytes: 4, budget: partial })).rejects.toThrow('budget exhausted');
    expect(reads).toHaveBeenCalledTimes(1); expect(partial.counters.indexBytes).toBe(65536);
  });

  it('accounts the first short read on cancellation and closes the real file without publishing text', async () => {
    const f = await fixture(JSON.stringify('x'.repeat(CHUNK * 2))), proto = await prototype(f.blob), original = proto.read;
    const controller = new AbortController(), budget = createWindowBudget();
    let actualStat: (() => Promise<unknown>) | undefined;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      actualStat = () => this.stat();
      const result = await (Reflect.apply(original, this, [target, offset, Math.min(137, length), position]) as ReturnType<typeof original>);
      controller.abort(); return result;
    }) as typeof original);
    await expect(read(f.path, binding, f.source, { ...f, maxBytes: 4096, budget, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.indexBytes).toBe(137); expect(budget.counters.outputBytes).toBe(0);
    await expect(actualStat!()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('rejects replacement after the last frame closes, before releasing an otherwise decoded page', async () => {
    const f = await fixture('"real"'), budget = createWindowBudget(), charge = budget.charge;
    vi.spyOn(budget, 'charge').mockImplementation((kind, amount) => {
      charge(kind, amount);
      if (kind === 'decodedBytes') { rmSync(f.blob); writeFileSync(f.blob, 'replacement'); }
    });
    await expect(read(f.path, binding, f.source, { ...f, maxBytes: 4096, budget })).rejects.toThrow('source changed');
  });

  it('does not accept an earlier quote as the end of the proven string range', async () => {
    const f = await fixture('"real"');
    await expect(read(f.path, binding, f.source, { ...f, range: { ...f.range, end: f.source.bytes }, maxBytes: 4096,
      budget: createWindowBudget() })).rejects.toThrow('range mismatch');
  });
});
