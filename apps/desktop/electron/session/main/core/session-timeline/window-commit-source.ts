import { createHash, randomUUID } from 'node:crypto';
import { link, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWindowFrame, encodeWindowFrame, windowFrameName, type WindowFrameKey } from '@gugu/session-core/session-record/window-cache/frame';
import { readWindowFrame, syncWindowDirectory, writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';

const CHUNK = 16 * 1024;
type Binding = Pick<WindowFrameKey, 'scope' | 'sourceLineage' | 'decoderVersion'>;
type Physical = { dev: string; ino: string; mtimeNs: string; ctimeNs: string };
export type WindowCommitSourceManifest = {
  version: 1; bytes: number; chunks: number; stride: number; sha256: string; physical: Physical;
};
const key = (binding: Binding, ordinal: number): WindowFrameKey => ({ ...binding, kind: 'segment', cursor: `raw:${String(ordinal).padStart(16, '0')}` });
const rootKey = (binding: Binding): WindowFrameKey => ({ ...binding, kind: 'head', cursor: 'raw:head' });
export const windowCommitSourcePath = (directory: string, binding: Binding) => join(directory, `${windowFrameName({ ...binding, kind: 'segment', cursor: 'raw:data' })}.source`);
const sourcePath = windowCommitSourcePath;
const stride = (binding: Binding) => encodeWindowFrame(key(binding, 0), new Uint8Array(0)).byteLength + CHUNK;
const physical = (value: { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint }): Physical => ({
  dev: String(value.dev), ino: String(value.ino), mtimeNs: String(value.mtimeNs), ctimeNs: String(value.ctimeNs),
});
function bound(value: WindowCommitSourceManifest, binding: Binding): void {
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.bytes) || value.bytes < 1
    || value.chunks !== Math.ceil(value.bytes / CHUNK) || value.stride !== stride(binding) || !Number.isSafeInteger(fileBytes(value))
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !value.physical || !['dev', 'ino', 'mtimeNs', 'ctimeNs'].every(name =>
      typeof value.physical[name as keyof Physical] === 'string' && /^-?\d{1,40}$/.test(value.physical[name as keyof Physical])))
    throw new Error('Invalid immutable commit source manifest');
}
const same = (a: Physical, b: Physical) => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const fileBytes = (source: WindowCommitSourceManifest) => source.bytes + source.chunks * (source.stride - CHUNK);

/** Metadata-only publication check against the receipt's physical identity. */
export async function assertWindowCommitSource(directory: string, binding: Binding, source: WindowCommitSourceManifest): Promise<void> {
  bound(source, binding);
  const current = await stat(sourcePath(directory, binding), { bigint: true });
  if (!current.isFile() || current.size !== BigInt(fileBytes(source)) || !same(physical(current), source.physical))
    throw new Error('Immutable commit source changed');
}

/** The existing canonical writer supplies its already serialized value. This
 * adds bounded encoding buffers, not a second full stringify/Buffer. The
 * writer's existing full serialization cost is deliberately not hidden. */
export async function writeWindowCommitSource(directory: string, binding: Binding, serialized: string,
  signal?: AbortSignal, receiptOwnsManifest = false, temporaryId = randomUUID()): Promise<WindowCommitSourceManifest> {
  if (!serialized.length) throw new Error('Commit source must not be empty');
  if (!/^[a-f0-9-]{36}$/.test(temporaryId)) throw new Error('Invalid commit source temporary id');
  const path = sourcePath(directory, binding), temporary = `${path}.${temporaryId}.tmp`;
  const width = stride(binding), buffer = Buffer.alloc(CHUNK), digest = createHash('sha256');
  let used = 0, chunks = 0, bytes = 0;
  try {
    signal?.throwIfAborted();
    const file = await open(temporary, 'wx', 0o600);
    try {
      const flush = async () => {
        if (!used) return;
        signal?.throwIfAborted();
        const payload = buffer.subarray(0, used), packet = encodeWindowFrame(key(binding, chunks), payload);
        let written = 0;
        while (written < packet.length) {
          const result = await file.write(packet, written, packet.length - written, chunks * width + written);
          if (result.bytesWritten <= 0) throw new Error('Short commit source write');
          written += result.bytesWritten;
        }
        digest.update(payload); bytes += used; chunks += 1; used = 0;
      };
      for (let at = 0; at < serialized.length;) {
        signal?.throwIfAborted();
        let end = Math.min(at + 4096, serialized.length);
        const last = serialized.charCodeAt(end - 1), next = serialized.charCodeAt(end);
        if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
        const part = Buffer.from(serialized.slice(at, end), 'utf8');
        for (let offset = 0; offset < part.length;) {
          const count = Math.min(CHUNK - used, part.length - offset);
          part.copy(buffer, used, offset, offset + count); used += count; offset += count;
          if (used === CHUNK) await flush();
        }
        at = end;
      }
      await flush(); signal?.throwIfAborted(); await file.sync();
    } finally { await file.close(); }
    signal?.throwIfAborted();
    // A new immutable name, never a rename over an existing committed source.
    await link(temporary, path); await rm(temporary); await syncWindowDirectory(directory);
    const observed = await stat(path, { bigint: true });
    const manifest: WindowCommitSourceManifest = { version: 1, bytes, chunks, stride: width,
      sha256: digest.digest('hex'), physical: physical(observed) };
    if (observed.size !== BigInt(fileBytes(manifest))) throw new Error('Commit source size changed before publication');
    signal?.throwIfAborted();
    // Production commits this exact manifest in the canonical row's receipt
    // transaction. A second cache head would add another file+directory fsync
    // without adding a canonical ownership proof. Standalone sources keep it.
    if (!receiptOwnsManifest) await writeWindowFrame(directory, rootKey(binding), Buffer.from(JSON.stringify(manifest), 'utf8'));
    return manifest;
  } finally { await rm(temporary, { force: true }); }
}

/** This is only a cache metadata read; an atomic canonical receipt must still
 * prove that the source belongs to a committed row before anything is ACKable. */
export async function readWindowCommitSourceManifest(directory: string, binding: Binding, budget: WindowBudget) {
  const result = await readWindowFrame(directory, rootKey(binding), budget);
  if (result.kind !== 'hit') return result;
  try {
    const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)) as WindowCommitSourceManifest;
    bound(source, binding); return { kind: 'hit' as const, source };
  } catch { return { kind: 'miss' as const, reason: 'format' as const }; }
}

/** Point-address one raw frame using the manifest bound by the canonical
 * receipt. A rewrite/replacement never becomes a fresh source by restatting. */
export async function readWindowCommitSourceChunk(directory: string, binding: Binding,
  source: WindowCommitSourceManifest, ordinal: number, budget: WindowBudget, signal?: AbortSignal): Promise<Uint8Array> {
  bound(source, binding);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= source.chunks) throw new RangeError('Invalid commit chunk ordinal');
  signal?.throwIfAborted();
  const path = sourcePath(directory, binding), position = ordinal * source.stride;
  const length = Math.min(source.stride, fileBytes(source) - position), file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(fileBytes(source)) || !same(physical(before), source.physical))
      throw new Error('Immutable commit source changed');
    let packet: Uint8Array = new Uint8Array(0), used = 0, failed = false, failure: unknown;
    await budget.read('indexBytes', length, async () => {
      packet = new Uint8Array(length);
      try {
        while (used < length) {
          signal?.throwIfAborted();
          const result = await file.read(packet, used, length - used, position + used);
          if (!result.bytesRead) break;
          used += result.bytesRead;
        }
      } catch (error) { failed = true; failure = error; }
      return used;
    });
    if (failed) throw failure;
    signal?.throwIfAborted();
    const after = await file.stat({ bigint: true }), named = await stat(path, { bigint: true });
    if (used !== length || after.size !== before.size || !same(physical(after), source.physical) || !same(physical(named), source.physical))
      throw new Error('Immutable commit source changed during read');
    const decoded = decodeWindowFrame(key(binding, ordinal), packet);
    const expected = Math.min(CHUNK, source.bytes - ordinal * CHUNK);
    if (decoded.kind !== 'hit' || decoded.bytes.byteLength !== expected) throw new Error('Invalid immutable commit source chunk');
    return decoded.bytes;
  } finally { await file.close(); }
}
