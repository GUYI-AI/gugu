import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { syncWindowDirectory } from './disk-frame';
import { readJsonStringBodyPage, writeDecodedBodyChunk } from './body-reader';
import { BODY_CHUNK_BYTES } from './types';
import type { SourceRange, SourceSnapshot, SourceFragment, WindowBodyRef, WindowByteSource, WindowReadRequest } from './types';
import { locateRecordBody } from './json-body-header';
import { sourceFragmentKey, windowRecordMetadata } from '../tail-source-identity';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** A real locator permits one prefix seek, never parsing or concatenating the giant record. */
export async function readRecordFirstBody(source: WindowByteSource, snapshot: SourceSnapshot, range: SourceRange,
  lineage: string, request: WindowReadRequest): Promise<SourceFragment | { kind: 'empty' } | null> {
  const provider = request.locator.harness;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported JSON body format');
  const header = await locateRecordBody(source, snapshot, range, request);
  if (header.kind === 'locating') return null;
  if (header.kind === 'empty') return { kind: 'empty' };
  const rawOffset = header.offset;
  const page = await readJsonStringBodyPage(source, { snapshot, position: { rawOffset, decodedOffset: 0 },
    end: range.end, maxBytes: 2 * BODY_CHUNK_BYTES, budget: request.budget, signal: request.signal });
  if (page.kind === 'reset') throw new Error('Located body source changed');
  const envelope = { provider, recordStart: range.start, sourceRange: range, fragment: 0, eventKind: 'source_fragment',
    revision: snapshot.snapshotRevision, projectionRef: 'source', recordMetadata: windowRecordMetadata(provider, header.metadata) };
  const key = sourceFragmentKey(envelope, { sourceScope: request.scope, sourceLineage: lineage,
    conversationScope: request.conversationScope, branchLineage: request.branchLineage, atCommit: 0, ancestryComplete: false });
  if (!key) throw new Error('Located body has no source identity');
  const body: WindowBodyRef = { version: 1, scope: request.scope, sourceLineage: lineage,
    id: hash(`${request.scope}:${lineage}:${range.start}:${header.offset - range.start}`), revision: snapshot.snapshotRevision,
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
