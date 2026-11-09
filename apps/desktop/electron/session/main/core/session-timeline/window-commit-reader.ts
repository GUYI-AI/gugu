import { decodeJsonStringBodyBytes, type JsonBodyPosition } from '@gugu/session-core/session-record/window-cache/body-reader';
import { BODY_TEXT_BYTES, type WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { assertWindowCommitSource, readWindowCommitSourceChunk, type writeWindowCommitSource, type WindowCommitSourceManifest } from './window-commit-source';

const CHUNK = 16 * 1024;
/** One request owns this reader and its budget. The two-frame cache is never
 * shared across requests or sources. Closing cancels pending work and releases
 * cached bytes; callers use finally, including the one-page body adapter. */
export function createWindowCommitReader(directory: string, binding: Parameters<typeof writeWindowCommitSource>[1],
  manifest: WindowCommitSourceManifest, budget: WindowBudget, signal?: AbortSignal) {
  // Pick bounded fields instead of retaining a caller's mutable receipt/object.
  const b = { scope: binding.scope, sourceLineage: binding.sourceLineage, decoderVersion: binding.decoderVersion };
  const source: WindowCommitSourceManifest = { version: manifest.version, bytes: manifest.bytes, chunks: manifest.chunks,
    stride: manifest.stride, sha256: manifest.sha256, physical: { dev: manifest.physical.dev, ino: manifest.physical.ino,
      mtimeNs: manifest.physical.mtimeNs, ctimeNs: manifest.physical.ctimeNs } };
  const cache = new Map<number, Uint8Array>(), controller = new AbortController();
  const abort = () => { controller.abort(signal?.reason); cache.clear(); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let busy = false;
  async function validate() { await assertWindowCommitSource(directory, b, source); controller.signal.throwIfAborted(); }
  async function span(start: number, length: number) {
    if (![start, length, start + length].every(Number.isSafeInteger) || start < 0 || length < 1 || length > CHUNK || start + length > source.bytes)
      throw new RangeError('Invalid commit reader span');
    controller.signal.throwIfAborted(); await validate();
    const first = Math.floor(start / CHUNK), last = Math.floor((start + length - 1) / CHUNK), output = new Uint8Array(length);
    let used = 0;
    for (let ordinal = first; ordinal <= last; ordinal++) {
      let bytes = cache.get(ordinal);
      if (bytes) cache.delete(ordinal);
      else {
        if (cache.size === 2) cache.delete(cache.keys().next().value!);
        bytes = await readWindowCommitSourceChunk(directory, b, source, ordinal, budget, controller.signal);
      }
      cache.set(ordinal, bytes);
      const offset = ordinal === first ? start % CHUNK : 0, part = bytes.subarray(offset, offset + length - used);
      output.set(part, used); used += part.length;
    }
    if (used !== length) throw new Error('Incomplete commit reader span');
    await validate();
    return output;
  }
  async function exclusive<T>(run: () => Promise<T>): Promise<T> {
    controller.signal.throwIfAborted();
    if (busy) throw new Error('Concurrent operations on one commit reader are not supported');
    busy = true;
    try { return await run(); } finally { busy = false; }
  }
  return {
    bytes(start: number, length: number) { return exclusive(() => span(start, length)); },
    string(inputRange: { start: number; end: number }, inputPosition: JsonBodyPosition, maxBytes: number) {
      const range = { start: inputRange.start, end: inputRange.end };
      const position = { rawOffset: inputPosition.rawOffset, decodedOffset: inputPosition.decodedOffset };
      return exclusive(async () => {
        if (![range.start, range.end, position.rawOffset, position.decodedOffset, maxBytes].every(Number.isSafeInteger)
          || range.start < 1 || range.end <= range.start || range.end > source.bytes
          || position.rawOffset < range.start || position.rawOffset >= range.end || position.decodedOffset < 0
          || position.decodedOffset > position.rawOffset - range.start || maxBytes < 4 || maxBytes > BODY_TEXT_BYTES)
          throw new RangeError('Invalid commit string position');
        const bytes = await span(position.rawOffset, Math.min(CHUNK, range.end - position.rawOffset));
        const page = decodeJsonStringBodyBytes(bytes, { position, end: range.end, maxBytes, budget, signal: controller.signal });
        if (page.complete && page.next.rawOffset !== range.end) throw new Error('Commit string range mismatch');
        await validate(); return page;
      });
    },
    close() {
      controller.abort(new DOMException('Commit reader closed', 'AbortError'));
      signal?.removeEventListener('abort', abort); cache.clear();
    },
  };
}
