import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract';
import { describe, expect, it, vi } from 'vitest';
import { nextPartBytes, readOneVersion, SMALLEST_PART_BYTES, uploadInParts } from './working-copy-upload';

describe('a part stays about a second long on whatever line it is', () => {
  it('doubles while quick, up to the largest; halves when long, down to the smallest; holds between', () => {
    expect(nextPartBytes(SMALLEST_PART_BYTES, 100)).toBe(SMALLEST_PART_BYTES * 2);
    expect(nextPartBytes(REMOTE_WORKSPACE_CHUNK_BYTES, 100)).toBe(REMOTE_WORKSPACE_CHUNK_BYTES);
    expect(nextPartBytes(SMALLEST_PART_BYTES * 4, 5000)).toBe(SMALLEST_PART_BYTES * 2);
    expect(nextPartBytes(SMALLEST_PART_BYTES, 5000)).toBe(SMALLEST_PART_BYTES);
    expect(nextPartBytes(SMALLEST_PART_BYTES * 2, 900)).toBe(SMALLEST_PART_BYTES * 2);
  });

  it('a file goes whole, in order, however its parts were sized, starting from the smallest', async () => {
    const bytes = new Uint8Array(1_000_000).map((_, at) => at % 251);
    const got: Uint8Array[] = [];
    const offsets: number[] = [];
    const write = vi.fn(async (part: { offset: number; data: string; final: boolean }) => {
      offsets.push(part.offset);
      got.push(Uint8Array.from(atob(part.data), (c) => c.charCodeAt(0)));
      return { received: 0, ...(part.final ? { entry: { id: 'f' } as never } : {}) };
    });
    const entries = await uploadInParts(write, { workspace: 'session:s' } as never, [{ name: 'f', blob: new Blob([bytes]) }], undefined);
    expect(entries).toHaveLength(1);
    expect(offsets[1]).toBe(SMALLEST_PART_BYTES);
    expect(Buffer.concat(got).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('a whole-file read stopped while anything in it is awaited', () => {
  const file = new Uint8Array(SMALLEST_PART_BYTES + 10).map((_, at) => at % 251);
  const readPiece = async (offset: number, length: number) => ({ size: file.length, etag: 'e', data: file.slice(offset, offset + length) });

  it.each(['begin', 'the last piece'] as const)('a stop while %s is awaited: stopped, and never answered as read', async (slow) => {
    const stop = new AbortController();
    let waiting = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handed: number[] = [];
    let saved = false;
    const reading = readOneVersion(readPiece, {
      signal: stop.signal,
      stopped: () => new Error('stopped'),
      changing: () => new Error('changing'),
      // As a download's truncate: really asynchronous.
      begin: async () => { if (slow === 'begin') { waiting = true; await gate; } },
      // As a download's write.
      piece: async (bytes, at) => {
        if (slow === 'the last piece' && at === file.length) { waiting = true; await gate; }
        handed.push(bytes.byteLength);
      },
    });
    void reading.then(() => { saved = true; }, () => undefined);
    await vi.waitFor(() => expect(waiting).toBe(true));
    stop.abort();
    release();
    await expect(reading).rejects.toThrow('stopped');
    expect(saved).toBe(false);
    expect(handed).toEqual(slow === 'begin' ? [] : [SMALLEST_PART_BYTES, 10]);
  });

  it('read to the end when nothing stops it, the last short piece whole', async () => {
    const got: Uint8Array[] = [];
    await expect(readOneVersion(readPiece, {
      signal: new AbortController().signal,
      stopped: () => new Error('stopped'),
      changing: () => new Error('changing'),
      begin: () => undefined,
      piece: (bytes) => { got.push(bytes); },
    })).resolves.toEqual({ size: file.length, etag: 'e' });
    expect(Buffer.concat(got).equals(Buffer.from(file))).toBe(true);
  });
});
