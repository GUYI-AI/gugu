import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { createPieceJoiner, createSeqOrderer, PACK_MIN_CHARS, PIECE_CHARS, toPieces } from './session-host-device-frames';

describe('task host frames over the device link', () => {
  it('splits a large frame into pieces and joins it back, binary included', () => {
    const big = 'x'.repeat(PIECE_CHARS * 2 + 10);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const batches = toPieces(['small', big, bytes]);
    const out: Array<string | Uint8Array> = [];
    const join = createPieceJoiner((frame) => out.push(frame));
    for (const batch of batches) join(batch);
    expect(out[0]).toBe('small');
    expect(out[1]).toBe(big);
    expect(Array.from(out[2] as Uint8Array)).toEqual([1, 2, 3, 250]);
    expect(batches.every((batch) => batch.length > 0)).toBe(true);
  });

  it('delivers batches in seq order and drops replays', () => {
    const out: string[] = [];
    const order = createSeqOrderer<string>((item) => out.push(item));
    order(1, 'b');
    order(0, 'a');
    order(0, 'a again');
    order(2, 'c');
    expect(out).toEqual(['a', 'b', 'c']);
  });

  describe('packed frames', () => {
    const pack = (frame: string) => frame.startsWith('{"t":"result"') ? gzipSync(frame).toString('base64') : null;
    const read = async (packed: string) => gunzipSync(Buffer.from(packed, 'base64')).toString();
    const answer = (chars: number) => JSON.stringify({ t: 'result', id: 7, ok: true, value: '往来 messages, '.repeat(Math.ceil(chars / 14)) });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

    it('packs what the sender says to pack, and nothing for a reader that did not ask', () => {
      const big = answer(PACK_MIN_CHARS * 20), event = JSON.stringify({ t: 'event', channel: 'x', data: 'y'.repeat(PACK_MIN_CHARS * 2) });
      expect(toPieces([big, event]).flat().some((piece) => 'z' in piece)).toBe(false);
      const [packed, plain] = toPieces([big, event], pack).flat();
      expect('z' in packed! && packed.z.length < big.length / 5).toBe(true);
      expect(plain).toEqual({ f: event });
    });

    it('sends a short frame, and one that would not get shorter, as it is', () => {
      const short = JSON.stringify({ t: 'result', id: 1, ok: true, value: null });
      const noise = '{"t":"result","v":"' + Array.from({ length: PACK_MIN_CHARS * 2 }, (_, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 20000))).join('') + '"}';
      expect(toPieces([short, noise], pack).flat()).toEqual([{ f: short }, { f: noise }]);
    });

    it('cuts a packed frame into pieces like any other, and hands frames over in the order they came', async () => {
      // Incompressible enough to stay over one piece when packed.
      const huge = JSON.stringify({ t: 'result', id: 2, ok: true, value: Array.from({ length: 60_000 }, (_, i) => (i * 2654435761 % 4294967296).toString(36)) });
      const batches = toPieces(['before', huge, 'after', answer(PACK_MIN_CHARS * 3), 'last'], pack);
      expect(batches.flat().filter((piece) => 'z' in piece && piece.n !== undefined).length).toBeGreaterThan(1);
      const out: Array<string | Uint8Array> = [];
      const failed = vi.fn();
      const join = createPieceJoiner((frame) => out.push(frame), { read, failed });
      for (const batch of batches) join(batch);
      // What came before the packed frame is not held back; what came after waits for it.
      expect(out).toEqual(['before']);
      await settle();
      expect(out).toEqual(['before', huge, 'after', answer(PACK_MIN_CHARS * 3), 'last']);
      join([{ f: 'later' }]);
      expect(out.at(-1)).toBe('later');
      expect(failed).not.toHaveBeenCalled();
    });

    it('tells the reader when a packed frame cannot be read, and goes on with the frames behind it', async () => {
      const out: Array<string | Uint8Array> = [];
      const failed = vi.fn();
      const join = createPieceJoiner((frame) => out.push(frame), { read, failed });
      join([{ z: 'not gzip at all' }, { f: 'after' }]);
      await settle();
      expect(failed).toHaveBeenCalledTimes(1);
      expect(out).toEqual(['after']);
    });

    it('refuses a packed frame at a reader that never asked for one', () => {
      const join = createPieceJoiner(() => undefined);
      expect(() => join([{ z: 'H4sIAAAA' }])).toThrow(/did not ask/);
    });
  });
});
