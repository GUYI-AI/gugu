import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBytePage, WINDOW_FRAME_BYTES, type WindowByteSource } from './byte-page.ts';
import { openWindowByteSource } from './file-source.ts';

describe('large sparse source byte bounds (#2062)', () => {
  it('seeks to the tail of a 2 GiB source and never reads its prefix', async () => {
    // Run on approved test infrastructure. No TailReader/watch is attached to this sparse fixture.
    // The unread prefix is intentionally not a valid full JSONL document: this tests physical I/O,
    // not the representativeness of a multi-gigabyte transcript or UI first-paint performance.
    const directory = await mkdtemp(join(tmpdir(), 'gugu-window-sparse-'));
    const path = join(directory, 'source.jsonl');
    const size = 2 ** 31 + 173;
    const tail = Buffer.from('{"role":"user","text":"最新内容"}\n');
    const writer = await open(path, 'w');
    try {
      await writer.truncate(size);
      await writer.write(Buffer.from('PREFIX_MUST_NOT_BE_READ'), 0, 23, 0);
      await writer.write(tail, 0, tail.length, size - tail.length);
    } finally { await writer.close(); }
    const source = await openWindowByteSource(path);
    let actualReadBytes = 0;
    const positions: number[] = [];
    const counted: WindowByteSource = {
      snapshot: () => source.snapshot(),
      async read(target, offset, length, position) {
        positions.push(position);
        const count = await source.read(target, offset, length, position);
        actualReadBytes += count;
        return count;
      }
    };
    try {
      expect((await stat(path)).size).toBe(size);
      const page = await readBytePage(counted);
      expect(page.kind).toBe('page');
      if (page.kind !== 'page') throw new Error('Expected current tail');
      expect(actualReadBytes).toBe(WINDOW_FRAME_BYTES);
      expect(positions.every(position => position >= size - WINDOW_FRAME_BYTES)).toBe(true);
      expect(Buffer.from(page.bytes.subarray(page.bytes.length - tail.length)).equals(tail)).toBe(true);
      expect(page.start).toBeGreaterThan(2 ** 31 - WINDOW_FRAME_BYTES);
      expect(page.older?.before).toBe(page.start);
    } finally {
      await source.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
