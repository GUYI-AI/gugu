import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readWindowFrame, writeWindowFrame, syncWindowDirectory } from './disk-frame';
import type { SourceRange, SourceSnapshot, WindowByteSource, WindowReadRequest } from './types';

type Frame = { path: string[]; array: boolean; key: string; index: number; state: 'key' | 'colon' | 'value' | 'comma' };
type Token = { kind: 'key' | 'metadata' | 'skip' | 'candidate'; raw: string | null; escaped: boolean; start: number; path: string[] };
type State = { version: 1; offset: number; stack: Frame[]; token: Token | null; skipDepth: number;
  skipString: boolean; skipEscape: boolean; primitive: boolean; metadata: Record<string, unknown>; bodyOffset?: number };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function metadataPath(path: string[]) {
  return path.length === 1 && ['uuid', 'parentUuid', 'type'].includes(path[0]) ||
    path.length === 2 && ['message', 'payload'].includes(path[0]) && ['id', 'type', 'role'].includes(path[1]);
}
function bodyPath(path: string[], provider: string) {
  if (path[0] !== (provider === 'claude' ? 'message' : 'payload')) return false;
  return path.length === 2 && ['content', 'message', 'output', 'arguments'].includes(path[1]) ||
    path[1] === 'content' && ['text', 'thinking', 'content'].includes(path.at(-1)!) &&
      (path.length === 4 || path.length === 5 && path[3] === 'input' || path.length === 6 && path[3] === 'content');
}
function enter(path: string[], provider: string) {
  if (!path.length) return true;
  if (path[0] !== (provider === 'claude' ? 'message' : 'payload')) return false;
  return path.length === 1 || path[1] === 'content' &&
    (path.length === 2 || path.length === 3 || path.length === 4 && ['content', 'input'].includes(path[3]) ||
      path.length === 5 && path[3] === 'content');
}
function advance(state: State, bytes: Uint8Array, start: number, provider: string): number | null {
  const consumed = () => { const frame = state.stack.at(-1); if (frame) { frame.state = 'comma'; if (frame.array) frame.index += 1; } };
  const path = () => { const frame = state.stack.at(-1); return frame ? [...frame.path, frame.array ? String(frame.index) : frame.key] : []; };
  for (let at = 0; at < bytes.length; at += 1) {
    const byte = bytes[at]; state.offset = start + at + 1;
    if (state.token) {
      const token = state.token;
      if (token.kind === 'candidate') {
        if (byte !== 34) return token.start; // Nonempty body; no body bytes are accumulated here.
        state.token = null; consumed(); continue;
      }
      if (!token.escaped && byte === 34) {
        if (token.raw !== null) {
          const value = JSON.parse(utf8.decode(Buffer.from('"' + token.raw + '"', 'latin1'))) as string;
          if (token.kind === 'key') { const frame = state.stack.at(-1)!; frame.key = value; frame.state = 'colon'; }
          else if (token.kind === 'metadata') {
            if (token.path.length === 1) state.metadata[token.path[0]] = value;
            else ((state.metadata[token.path[0]] ??= {}) as Record<string, unknown>)[token.path[1]] = value;
            consumed();
          } else consumed();
        } else {
          if (token.kind === 'key') { const frame = state.stack.at(-1)!; frame.key = ''; frame.state = 'colon'; }
          else consumed();
        }
        state.token = null; continue;
      }
      // Only bounded identity scalars and short field names can enter a checkpoint.
      // Other strings are streamed byte by byte; their contents are never retained.
      if (token.raw !== null) token.raw = token.raw.length < 256 ? token.raw + String.fromCharCode(byte) : null;
      if (token.escaped) token.escaped = false;
      else if (byte === 92) token.escaped = true;
      continue;
    }
    if (state.skipDepth) {
      if (state.skipString) {
        if (state.skipEscape) state.skipEscape = false;
        else if (byte === 92) state.skipEscape = true;
        else if (byte === 34) state.skipString = false;
      } else if (byte === 34) state.skipString = true;
      else if (byte === 123 || byte === 91) state.skipDepth += 1;
      else if (byte === 125 || byte === 93) state.skipDepth -= 1;
      continue;
    }
    if (state.primitive) {
      if (![44, 93, 125, 32, 9, 10, 13].includes(byte)) continue;
      state.primitive = false;
    }
    const frame = state.stack.at(-1);
    if ([32, 9, 10, 13].includes(byte)) continue;
    if (byte === 123 || byte === 91) {
      const currentPath = path(); consumed();
      if (enter(currentPath, provider)) state.stack.push({ path: currentPath, array: byte === 91, key: '', index: 0, state: byte === 91 ? 'value' : 'key' });
      else state.skipDepth = 1;
    } else if (byte === 125 || byte === 93) state.stack.pop();
    else if (byte === 44) { if (!frame) throw new SyntaxError('Unexpected header comma'); frame.state = frame.array ? 'value' : 'key'; }
    else if (byte === 58) { if (!frame || frame.state !== 'colon') throw new SyntaxError('Unexpected header colon'); frame.state = 'value'; }
    else if (byte === 34) {
      const currentPath = path();
      const kind = frame?.state === 'key' ? 'key' : bodyPath(currentPath, provider) ? 'candidate' : metadataPath(currentPath) ? 'metadata' : 'skip';
      state.token = { kind, raw: kind === 'key' || kind === 'metadata' ? '' : null, escaped: false, start: start + at + 1, path: currentPath };
    } else { consumed(); state.primitive = true; }
  }
  return null;
}

export function recordHeaderKey(snapshot: SourceSnapshot, range: SourceRange, request: WindowReadRequest) {
  return { scope: request.scope, sourceLineage: snapshot.sourceInstance, decoderVersion: 1, kind: 'head' as const,
    cursor: 'body-header:' + digest(JSON.stringify([snapshot.snapshotRevision, range.start, range.end])) };
}
function cachedState(bytes: Uint8Array, range: SourceRange): State | null {
  try {
    const state = JSON.parse(utf8.decode(bytes)) as State;
    const object = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const position = (value: number) => Number.isSafeInteger(value) && value >= range.start && value <= range.end;
    const strings = (value: unknown, keys: string[]) => object(value) &&
      Object.entries(value as Record<string, unknown>).every(([key, item]) => keys.includes(key) && typeof item === 'string');
    if (!state || state.version !== 1 || !position(state.offset) || !Array.isArray(state.stack) ||
      !state.stack.every(frame => object(frame) && Array.isArray(frame.path) && frame.path.every(part => typeof part === 'string') &&
        typeof frame.array === 'boolean' && typeof frame.key === 'string' && Number.isSafeInteger(frame.index) && frame.index >= 0 &&
        ['key', 'colon', 'value', 'comma'].includes(frame.state)) ||
      !Number.isSafeInteger(state.skipDepth) || state.skipDepth < 0 || !object(state.metadata) ||
      !['skipString', 'skipEscape', 'primitive'].every(field => typeof state[field as keyof State] === 'boolean') ||
      !Object.entries(state.metadata).every(([key, item]) => ['message', 'payload'].includes(key)
        ? strings(item, ['id', 'type', 'role']) : ['uuid', 'parentUuid', 'type'].includes(key) && typeof item === 'string') ||
      state.bodyOffset !== undefined && !position(state.bodyOffset)) return null;
    const token = state.token;
    if (token !== null && (!object(token) || !['key', 'metadata', 'skip', 'candidate'].includes(token.kind) ||
      token.raw !== null && (typeof token.raw !== 'string' || token.raw.length > 256) ||
      ['candidate', 'skip'].includes(token.kind) && token.raw !== null || typeof token.escaped !== 'boolean' || !position(token.start) ||
      !Array.isArray(token.path) || !token.path.every(part => typeof part === 'string'))) return null;
    return state;
  } catch { return null; } // Only bounded cache payload decoding; I/O and budget errors remain outside this repair.
}

/** One source block per invocation. The fixed checkpoint survives a process restart. */
export async function locateRecordBody(source: WindowByteSource, snapshot: SourceSnapshot, range: SourceRange, request: WindowReadRequest) {
  const key = recordHeaderKey(snapshot, range, request);
  const directory = join(request.cacheDirectory, 'body-headers');
  const previous = await readWindowFrame(directory, key, request.budget);
  let state: State | null = null;
  if (previous.kind === 'hit') {
    request.budget.charge('decodedBytes', previous.bytes.length);
    state = cachedState(previous.bytes, range);
  } else {
    if (previous.reason === 'io') throw previous.error;
  }
  // A disposable derived checkpoint can be rebuilt only from this real record
  // anchor, using the same request budget, without scanning the source prefix.
  state ??= { version: 1, offset: range.start, stack: [], token: null, skipDepth: 0, skipString: false, skipEscape: false, primitive: false, metadata: {} };
  if (state.bodyOffset !== undefined) return { kind: 'located' as const, offset: state.bodyOffset, metadata: state.metadata };
  async function save() {
    await mkdir(directory, { recursive: true }); await syncWindowDirectory(request.cacheDirectory);
    await writeWindowFrame(directory, key, Buffer.from(JSON.stringify(state)));
  }
  const start = state.offset, length = Math.min(65536, range.end - start);
  if (!length) return { kind: 'empty' as const };
  let bytes = new Uint8Array(0), used = 0, failed = false, failure: unknown;
  await request.budget.read('sourceBytes', length, async () => {
    bytes = new Uint8Array(length);
    try { while (used < length && !request.signal?.aborted) { const count = await source.read(bytes, used, length - used, start + used);
      if (!Number.isSafeInteger(count) || count < 0 || count > length - used) throw new RangeError('Invalid header read length');
      if (!count) break; used += count; } }
    catch (error) { failed = true; failure = error; }
    return used;
  });
  if (failed) throw failure;
  request.signal?.throwIfAborted();
  const current = await source.snapshot();
  if (used !== length || current.sourceInstance !== snapshot.sourceInstance || current.snapshotRevision !== snapshot.snapshotRevision)
    throw new Error('Source changed while locating body header');
  request.budget.charge('decodedBytes', length);
  const offset = advance(state, bytes, start, request.locator.harness);
  if (offset !== null) { state.bodyOffset = offset; await save(); return { kind: 'located' as const, offset, metadata: state.metadata }; }
  if (state.offset === range.end) return { kind: 'empty' as const };
  await save();
  return { kind: 'locating' as const, nextOffset: state.offset };
}
