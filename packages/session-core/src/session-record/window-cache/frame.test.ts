import { describe, expect, it } from 'vitest';
import { decodeWindowFrame, encodeWindowFrame, FRAME_PAYLOAD_BYTES, type WindowFrameKey } from './frame';

const key: WindowFrameKey = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1, kind: 'body', cursor: 'item:12' };

describe('versioned immutable frames', () => {
  it('checks exact identity and decoder ownership independently of a read revision', () => {
    const bytes = Buffer.from('中文、emoji 😀、quotes " and escapes \\');
    const packet = encodeWindowFrame(key, bytes);
    const read = decodeWindowFrame(key, packet);
    expect(read.kind === 'hit' && Buffer.from(read.bytes).equals(bytes)).toBe(true);
    for (const changed of [{ scope: 'c'.repeat(64) }, { sourceLineage: 'c'.repeat(64) }, { decoderVersion: 2 }, { cursor: 'item:13' }]) {
      expect(decodeWindowFrame({ ...key, ...changed }, packet)).toEqual({ kind: 'miss', reason: 'key' });
    }
  });

  it('rejects corrupt payload, torn packets and the old metadata schema', () => {
    const packet = encodeWindowFrame(key, Buffer.from('body'));
    packet[packet.length - 1] = packet[packet.length - 1]! ^ 1;
    expect(decodeWindowFrame(key, packet)).toEqual({ kind: 'miss', reason: 'checksum' });
    expect(decodeWindowFrame(key, packet.subarray(0, packet.length - 1))).toEqual({ kind: 'miss', reason: 'format' });
    packet.set(Buffer.from('GUGUWIN1'));
    expect(decodeWindowFrame(key, packet)).toEqual({ kind: 'miss', reason: 'format' });
  });

  it('checks limits and scalar schemas before encoding', () => {
    expect(() => encodeWindowFrame(key, new Uint8Array(FRAME_PAYLOAD_BYTES + 1))).toThrow('split');
    expect(() => encodeWindowFrame({ ...key, cursor: 'x'.repeat(129) }, new Uint8Array())).toThrow('key');
    expect(() => encodeWindowFrame({ ...key, decoderVersion: 0 }, new Uint8Array())).toThrow('key');
    expect(decodeWindowFrame(key, encodeWindowFrame(key, new Uint8Array(FRAME_PAYLOAD_BYTES))).kind).toBe('hit');
  });
});
