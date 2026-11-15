import { createHash } from 'node:crypto';
import { openWindowByteSource } from './file-source';
import { readSourceLocator } from './source-locator';
import { readJsonlWindow, type JsonlRecordSlice } from './jsonl-window';
import { readIndexedBodyPage, type BodyPageIo } from './body-reader';
import { sourceFragmentKey, windowRecordMetadata } from '../tail-source-identity';
import { readRecordFirstBody } from './record-first-body';
import type { PendingLongRecord, SourceFragment, SourceRange, SourceSnapshot, WindowByteSource, WindowCursor, WindowReadRequest, WindowResult } from './types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type OpenSource = { source: WindowByteSource; sourceLineage: string; readEnd?: number; close(): Promise<void> };
export interface RecentReaderIo {
  openSource?(request: WindowReadRequest): Promise<OpenSource | null>;
  schedulePending(request: WindowReadRequest, snapshot: SourceSnapshot, ticket: PendingLongRecord): Promise<SourceRange | void>;
  body: BodyPageIo;
  headerProgress?(request: WindowReadRequest): void;
}
async function openSource(request: WindowReadRequest): Promise<OpenSource | null> {
  const harness = request.locator.harness;
  if (harness !== 'claude' && harness !== 'codex') throw new Error('Window source format is not registered');
  const located = await readSourceLocator(request.cacheDirectory, harness, request.locator.providerSessionId, request.budget);
  if (located.kind !== 'hit') {
    if (located.reason === 'io') throw located.error;
    if (located.reason !== 'not_found') throw new Error(`Source locator failure: ${located.reason}`);
    return null;
  }
  const source = await openWindowByteSource(located.locator.path);
  if ((await source.snapshot()).sourceInstance !== located.locator.source.sourceInstance) {
    await source.close(); throw new Error('Source locator refers to a replaced source');
  }
  return { source, sourceLineage: located.locator.sourceLineage, close: () => source.close() };
}

function fragment(request: WindowReadRequest, lineage: string, record: JsonlRecordSlice): SourceFragment | null {
  request.budget.charge('decodedBytes', record.bytes.length);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(record.bytes);
  const data = JSON.parse(text) as Record<string, unknown>;
  const provider = request.locator.harness;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported fragment provider');
  const message = (provider === 'claude' ? data.message : data.payload) as Record<string, unknown> | undefined;
  if (!message || typeof message !== 'object') return null;
  const kind = String(message.type ?? data.type ?? '');
  const role = message.role ?? (kind === 'user_message' ? 'user' : kind === 'agent_message' ? 'assistant' :
    kind === 'function_call_output' || kind === 'function_call' ? 'tool' : undefined);
  const content = message.content ?? message.message ?? message.output ?? message.arguments;
  const pieces = typeof content === 'string' ? [content] : Array.isArray(content)
    ? content.flatMap(block => block && typeof block === 'object'
      ? typeof block.text === 'string' ? [block.text] : typeof block.thinking === 'string' ? [block.thinking]
        : typeof block.content === 'string' ? [block.content] : [] : []) : [];
  if (!pieces.length) return null;
  const envelope = { provider, recordStart: record.range.start, sourceRange: record.range, fragment: 0,
    eventKind: 'source_fragment', revision: hash(text), projectionRef: 'source', recordMetadata: windowRecordMetadata(provider, data) };
  const key = sourceFragmentKey(envelope, { sourceScope: request.scope, sourceLineage: lineage,
    conversationScope: request.conversationScope, branchLineage: request.branchLineage, atCommit: 0, ancestryComplete: false });
  if (!key) throw new Error('A located fragment has no stable source identity');
  return { key, sourceRange: record.range, ownership: 'unresolved', text: pieces.join('\n'),
    ...(role === 'user' || role === 'assistant' || role === 'tool' ? { knownRole: role } : {}) };
}

/** Cold opening and upward paging use the same bounded suffix path; no legacy factory is reachable. */
export function createRecentReader(io: RecentReaderIo) {
  async function read(request: WindowReadRequest, cursor?: WindowCursor): Promise<WindowResult> {
    const { budget, signal } = request;
    signal?.throwIfAborted();
    const opened = await (io.openSource ?? openSource)(request);
    if (!opened) return { kind: 'cache_miss', reason: 'not_found', cursor: cursor ?? null, io: budget.counters };
    try {
      const snapshot = await opened.source.snapshot();
      const readEnd = opened.readEnd ?? snapshot.size;
      if (!Number.isSafeInteger(readEnd) || readEnd < 0 || readEnd > snapshot.size)
        return { kind: 'reset', reason: 'source_changed', io: budget.counters };
      if (cursor && (cursor.scope !== request.scope || cursor.sourceLineage !== opened.sourceLineage || cursor.snapshotRevision !== snapshot.snapshotRevision))
        return { kind: 'reset', reason: 'invalid_cursor', io: budget.counters };
      if (cursor && cursor.before > readEnd) return { kind: 'reset', reason: 'invalid_cursor', io: budget.counters };
      const result = await readJsonlWindow(opened.source, { budget, signal, limit: Math.min(request.limit ?? 20, 20),
        ...(cursor || opened.readEnd !== undefined ? { cursor: { sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance,
          snapshotRevision: snapshot.snapshotRevision, before: cursor?.before ?? readEnd } } : {}) });
      if (result.kind === 'reset') return { ...result, io: budget.counters };
      const sourceFragments = result.records.map(record => fragment(request, opened.sourceLineage, record)).filter((value): value is SourceFragment => value !== null).reverse();
      const pendingLongRecords: PendingLongRecord[] = [];
      let locatedStart: number | undefined;
      if (result.headFragment) {
        const { recordEnd, scanBefore } = result.headFragment;
        const ticket: PendingLongRecord = { kind: 'pending_long_record', ticket: hash(`${request.scope}:${snapshot.sourceInstance}:${recordEnd}`),
          sourceInstance: snapshot.sourceInstance, pinnedEnd: readEnd, nextScanOffset: scanBefore,
          sourceFence: { start: recordEnd, end: recordEnd, digest: hash('') } };
        const located = await io.schedulePending(request, snapshot, ticket);
        const firstBody = located ? await readRecordFirstBody(opened.source, snapshot, located, opened.sourceLineage, request) : null;
        if (firstBody) {
          if ('key' in firstBody) sourceFragments.unshift(firstBody);
          locatedStart = located!.start;
        } else { pendingLongRecords.push(ticket); if (located) io.headerProgress?.(request); }
      }
      signal?.throwIfAborted();
      const current = await opened.source.snapshot();
      if (current.sourceInstance !== snapshot.sourceInstance || current.snapshotRevision !== snapshot.snapshotRevision || current.size !== snapshot.size)
        return { kind: 'reset', reason: 'source_changed', io: budget.counters };
      const before = locatedStart ?? result.older?.before;
      const olderCursor = before ? { version: 1 as const, scope: request.scope, sourceLineage: opened.sourceLineage,
        snapshotRevision: snapshot.snapshotRevision, before, segment: null } : null;
      const value = { kind: pendingLongRecords.length ? 'continuation' as const : 'page' as const, scope: request.scope,
        sourceLineage: opened.sourceLineage, snapshotRevision: snapshot.snapshotRevision, commitSeq: 0, turns: [],
        bodyRefs: sourceFragments.flatMap(value => value.bodyRef ? [value.bodyRef] : []), sourceFragments,
        coveredRanges: result.records.map(record => record.range), olderCursor,
        moreBefore: pendingLongRecords.length ? 'unknown' as const : olderCursor ? 'yes' as const : 'no' as const, pendingLongRecords };
      // Encoding only this already bounded page also accounts for escaping and metadata.
      budget.charge('outputBytes', Buffer.byteLength(JSON.stringify(value)));
      return { ...value, io: budget.counters };
    } finally { await opened.close(); }
  }
  return { openRecent: (request: WindowReadRequest) => read(request),
    readOlder: (request: WindowReadRequest & { cursor: WindowCursor }) => read(request, request.cursor),
    readBody: (request: WindowReadRequest & Parameters<typeof readIndexedBodyPage>[1]) => readIndexedBodyPage(io.body, request) };
}
