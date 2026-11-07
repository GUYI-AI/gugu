import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncWindowDirectory } from './disk-frame';
import { readJsonStringBodyPage, writeDecodedBodyChunk } from './body-reader';
import { BODY_CHUNK_BYTES } from './types';
import type { SourceRange, SourceSnapshot, SourceFragment, WindowBodyRef, WindowByteSource, WindowReadRequest } from './types';
import { sourceFragmentKey, windowRecordMetadata } from '../tail-source-identity';

type Container = { path: string[]; array: boolean; key: string; index: number; state: 'key' | 'colon' | 'value' | 'comma' };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Tokenize only the admitted prefix. A body string is returned before its contents are materialized. */
function bodyStart(bytes: Uint8Array, provider: 'claude' | 'codex') {
  const stack: Container[] = [], metadata: Record<string, unknown> = {};
  let at = 0;
  const path = () => {
    const top = stack.at(-1);
    return top ? [...top.path, top.array ? String(top.index) : top.key] : [];
  };
  const consumed = () => { const top = stack.at(-1); if (top) { top.state = 'comma'; if (top.array) top.index += 1; } };
  const isBody = (parts: string[]) => {
    if (parts[0] !== (provider === 'claude' ? 'message' : 'payload')) return false;
    const last = parts.at(-1);
    return parts.length === 2 && ['content', 'message', 'output', 'arguments'].includes(last!) ||
      parts[1] === 'content' && parts.length > 2 && ['text', 'thinking', 'content'].includes(last!);
  };
  const remember = (parts: string[], value: unknown) => {
    if (parts.length === 1 && ['uuid', 'parentUuid', 'type', 'task_id', 'call_id'].includes(parts[0])) metadata[parts[0]] = value;
    if (parts.length === 2 && ['message', 'payload'].includes(parts[0]) &&
      ['id', 'uuid', 'type', 'role', 'task_id', 'call_id'].includes(parts[1])) {
      const nested = (metadata[parts[0]] ??= {}) as Record<string, unknown>;
      nested[parts[1]] = value;
    }
  };
  while (at < bytes.length) {
    const byte = bytes[at], top = stack.at(-1);
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13) { at += 1; continue; }
    if (byte === 123 || byte === 91) {
      const currentPath = path(); consumed();
      stack.push({ path: currentPath, array: byte === 91, key: '', index: 0, state: byte === 91 ? 'value' : 'key' }); at += 1; continue;
    }
    if (byte === 125 || byte === 93) { stack.pop(); at += 1; continue; }
    if (byte === 44) { if (!top) throw new SyntaxError('Unexpected JSON comma'); top.state = top.array ? 'value' : 'key'; at += 1; continue; }
    if (byte === 58) { if (!top || top.state !== 'colon') throw new SyntaxError('Unexpected JSON colon'); top.state = 'value'; at += 1; continue; }
    if (byte === 34) {
      const parts = path();
      if (top?.state === 'value' && isBody(parts)) return { offset: at + 1, metadata };
      let end = at + 1, escaped = false;
      for (; end < bytes.length; end += 1) {
        if (escaped) { escaped = false; continue; }
        if (bytes[end] === 92) { escaped = true; continue; }
        if (bytes[end] === 34) break;
      }
      if (end === bytes.length) return null;
      const text = JSON.parse(utf8.decode(bytes.subarray(at, end + 1))) as string;
      if (top?.state === 'key') { top.key = text; top.state = 'colon'; }
      else { remember(parts, text); consumed(); }
      at = end + 1; continue;
    }
    let end = at;
    while (end < bytes.length && ![44, 93, 125, 32, 9, 10, 13].includes(bytes[end])) end += 1;
    if (end === bytes.length) return null;
    JSON.parse(utf8.decode(bytes.subarray(at, end))); consumed(); at = end;
  }
  return null;
}

/** A real locator permits one prefix seek, never parsing or concatenating the giant record. */
export async function readRecordFirstBody(source: WindowByteSource, snapshot: SourceSnapshot, range: SourceRange,
  lineage: string, request: WindowReadRequest): Promise<SourceFragment | null> {
  const provider = request.locator.harness;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported JSON body format');
  const length = Math.min(64 * 1024, range.end - range.start);
  let bytes = new Uint8Array(0), used = 0, failure: unknown;
  await request.budget.read('sourceBytes', length, async () => {
    bytes = new Uint8Array(length);
    try {
      while (used < length && !request.signal?.aborted) {
        const count = await source.read(bytes, used, length - used, range.start + used);
        if (!Number.isSafeInteger(count) || count < 0 || count > length - used) throw new RangeError('Invalid source read length');
        if (!count) break;
        used += count;
      }
    } catch (error) { failure = error; }
    return used;
  });
  if (failure) throw failure;
  request.signal?.throwIfAborted();
  if (used !== length) throw new Error('Located source prefix changed');
  request.budget.charge('decodedBytes', length);
  const header = bodyStart(bytes, provider);
  if (!header) return null;
  const rawOffset = range.start + header.offset;
  const page = await readJsonStringBodyPage(source, { snapshot, position: { rawOffset, decodedOffset: 0 },
    end: range.end, maxBytes: 2 * BODY_CHUNK_BYTES, budget: request.budget, signal: request.signal });
  if (page.kind === 'reset') throw new Error('Located body source changed');
  const envelope = { provider, recordStart: range.start, sourceRange: range, fragment: 0, eventKind: 'source_fragment',
    revision: snapshot.snapshotRevision, projectionRef: 'source', recordMetadata: windowRecordMetadata(provider, header.metadata) };
  const key = sourceFragmentKey(envelope, { sourceScope: request.scope, sourceLineage: lineage,
    conversationScope: request.conversationScope, branchLineage: request.branchLineage, atCommit: 0, ancestryComplete: false });
  if (!key) throw new Error('Located body has no source identity');
  const body: WindowBodyRef = { version: 1, scope: request.scope, sourceLineage: lineage,
    id: hash(`${request.scope}:${lineage}:${range.start}:${header.offset}`), revision: snapshot.snapshotRevision,
    owner: { kind: 'fragment', fragmentKey: key }, sourceRange: { start: rawOffset, end: range.end },
    firstChunk: null, decoderCheckpoint: null, byteLength: page.complete ? Buffer.byteLength(page.text) : null };
  const decoded = Buffer.from(page.text);
  const directory = join(request.cacheDirectory, 'bodies');
  await mkdir(directory, { recursive: true }); await syncWindowDirectory(request.cacheDirectory);
  const first = await writeDecodedBodyChunk(directory, body, 0,
    decoded.subarray(0, BODY_CHUNK_BYTES), body.sourceRange, request.budget);
  body.firstChunk = first.content;
  // Full fixed chunks are immutable. An unfinished second chunk is located later,
  // rather than publishing a partial chunk that would have to be rewritten.
  if (decoded.length > BODY_CHUNK_BYTES && (page.complete || decoded.length === 2 * BODY_CHUNK_BYTES))
    await writeDecodedBodyChunk(directory, body, 1, decoded.subarray(BODY_CHUNK_BYTES), body.sourceRange, request.budget);
  const current = await source.snapshot();
  if (current.sourceInstance !== snapshot.sourceInstance || current.snapshotRevision !== snapshot.snapshotRevision)
    throw new Error('Source changed before body publication');
  let end = Math.min(BODY_CHUNK_BYTES, decoded.length);
  while (end < decoded.length && (decoded[end] & 0xc0) === 0x80) end -= 1;
  const message = (header.metadata.message ?? header.metadata.payload) as Record<string, unknown> | undefined;
  const role = message?.role;
  return { key, sourceRange: range, ownership: 'unresolved', bodyRef: body,
    text: utf8.decode(decoded.subarray(0, end)),
    ...(role === 'user' || role === 'assistant' || role === 'tool' ? { knownRole: role } : {}) };
}
