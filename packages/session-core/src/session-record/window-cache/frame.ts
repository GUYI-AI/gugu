import { createHash, timingSafeEqual } from 'node:crypto';

const MAGIC = Buffer.from('GUGUWIN2');
const HEADER_BYTES = 48;
const META_BYTES = 4096;
// Leave room for metadata inside the aggregate 64 KiB cache-read budget.
export const FRAME_PAYLOAD_BYTES = 60 * 1024;
export const MAX_WINDOW_FILE_BYTES = HEADER_BYTES + META_BYTES + FRAME_PAYLOAD_BYTES;
export type WindowFrameKey = {
  scope: string;
  sourceLineage: string;
  decoderVersion: number;
  kind: 'projection' | 'checkpoint' | 'segment' | 'head' | 'body' | 'locator';
  cursor: string;
};
export type WindowFrameRead =
  | { kind: 'hit'; bytes: Uint8Array }
  | { kind: 'miss'; reason: 'format' | 'checksum' | 'key' | 'not_found' | 'io'; error?: unknown };

/** Only bounded scalar fields reach JSON encoding; read revisions are not identities. */
function canonicalKey(key: WindowFrameKey): string {
  if (typeof key.scope !== 'string' || !/^[a-f0-9]{64}$/.test(key.scope) ||
    typeof key.sourceLineage !== 'string' || !/^[a-f0-9]{64}$/.test(key.sourceLineage) ||
    !Number.isSafeInteger(key.decoderVersion) || key.decoderVersion < 1 ||
    !['projection', 'checkpoint', 'segment', 'head', 'body', 'locator'].includes(key.kind) ||
    typeof key.cursor !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(key.cursor)) throw new Error('Invalid window frame key');
  return JSON.stringify({ version: 2, scope: key.scope, sourceLineage: key.sourceLineage,
    decoderVersion: key.decoderVersion, kind: key.kind, cursor: key.cursor });
}
export function windowFrameName(key: WindowFrameKey): string {
  return `${createHash('sha256').update(canonicalKey(key)).digest('hex')}.frame`;
}
export function encodeWindowFrame(key: WindowFrameKey, bytes: Uint8Array): Buffer {
  if (bytes.byteLength > FRAME_PAYLOAD_BYTES) throw new Error('Window payload must be split before encoding');
  const meta = Buffer.from(canonicalKey(key), 'utf8');
  if (key.kind === 'head' && HEADER_BYTES + meta.length + bytes.byteLength > 4096) throw new Error('Encoded window head exceeds 4 KiB');
  const packet = Buffer.alloc(HEADER_BYTES + meta.length + bytes.byteLength);
  MAGIC.copy(packet);
  packet.writeUInt32BE(meta.length, 8);
  packet.writeUInt32BE(bytes.byteLength, 12);
  meta.copy(packet, HEADER_BYTES);
  packet.set(bytes, HEADER_BYTES + meta.length);
  createHash('sha256').update(packet.subarray(HEADER_BYTES)).digest().copy(packet, 16);
  return packet;
}
/** Integrity and binding only: publishing a hit also requires a source-fence check. */
export function decodeWindowFrame(expected: WindowFrameKey, packet: Uint8Array): WindowFrameRead {
  const wanted = canonicalKey(expected);
  if (expected.kind === 'head' && packet.byteLength > 4096) return { kind: 'miss', reason: 'format' };
  if (packet.byteLength < HEADER_BYTES || packet.byteLength > MAX_WINDOW_FILE_BYTES) return { kind: 'miss', reason: 'format' };
  const buffer = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
  if (!buffer.subarray(0, 8).equals(MAGIC)) return { kind: 'miss', reason: 'format' };
  const metaLength = buffer.readUInt32BE(8), payloadLength = buffer.readUInt32BE(12);
  if (metaLength > META_BYTES || payloadLength > FRAME_PAYLOAD_BYTES || HEADER_BYTES + metaLength + payloadLength !== buffer.length)
    return { kind: 'miss', reason: 'format' };
  const digest = createHash('sha256').update(buffer.subarray(HEADER_BYTES)).digest();
  if (!timingSafeEqual(digest, buffer.subarray(16, HEADER_BYTES))) return { kind: 'miss', reason: 'checksum' };
  if (buffer.toString('utf8', HEADER_BYTES, HEADER_BYTES + metaLength) !== wanted) return { kind: 'miss', reason: 'key' };
  return { kind: 'hit', bytes: buffer.subarray(HEADER_BYTES + metaLength) };
}
