import type {
  RecordCursor, SessionpageSessionBodyReadRequest, SessionpageSessionEvent,
  SessionpageSessionOlderRequest, SessionpageSessionSubscribeRequest,
  TimelineAfterResult, TimelineOlderResult, TimelineSnapshot,
  SessionpageSessionWindowStatusEvent,
} from '@gugu/session-core/session-record/contract';
import type {
  WindowBodyResult, WindowPage, WindowReadRequest, WindowResult,
} from '../../../../../../../packages/session-core/src/session-record/window-cache/types';

export interface DesktopWindowIo {
  finish?(request: WindowReadRequest): void;
  request(conversationId: string, limit?: number, signal?: AbortSignal): Promise<WindowReadRequest>;
  openRecent(request: WindowReadRequest): Promise<WindowResult>;
  readOlder(request: WindowReadRequest & { cursor: NonNullable<WindowPage['olderCursor']> }): Promise<WindowResult>;
  readBody(request: WindowReadRequest & SessionpageSessionBodyReadRequest): Promise<WindowBodyResult>;
  /** Observe a source revision; this must not acquire a legacy timeline. */
  watch(conversationId: string, changed: () => void, request: WindowReadRequest, failed: (error: unknown) => void): Promise<() => void>;
}

function page(result: WindowResult): WindowPage {
  if (result.kind === 'reset') throw new Error(`Window source reset: ${result.reason}`);
  if (result.kind === 'cache_miss') throw new Error(`Window cache unresolved: ${result.reason}`);
  return result;
}
function project(value: WindowPage): TimelineSnapshot {
  const { kind: _kind, scope: _scope, commitSeq: _commit, io: _io, turns, ...fields } = value;
  const seq = Math.max(0, ...value.coveredRanges.map(range => range.end), ...value.pendingLongRecords.map(ticket => ticket.pinnedEnd));
  // A byte endpoint is not an event revision: same-size rewrites must replace the
  // client window. Append rebasing requires a separately verified source anchor.
  return { ...fields, cursor: { epoch: `${value.sourceLineage}:${value.snapshotRevision}`, seq }, turns, settlements: [], hasOlder: value.moreBefore !== 'no' };
}
function afterPage(snapshot: TimelineSnapshot, cursor: RecordCursor | null): TimelineAfterResult {
  if (!cursor || cursor.epoch !== snapshot.cursor.epoch) return { ok: false, reset: 'epoch_changed', snapshot };
  if (cursor.seq > snapshot.cursor.seq) return { ok: false, reset: 'cursor_ahead', snapshot };
  const { turns, settlements, hasOlder: _older, ...fields } = snapshot;
  return { ok: true, batch: { ...fields, from: cursor.seq, settlements, removedTurnIds: [],
    turns: turns.map(turn => ({ ...turn, itemIds: turn.items.map(item => item.id) })) } };
}

/** All four read/subscribe paths share bounded window I/O. No timeline or archive is acquired. */
export function createDesktopWindowReader(io: DesktopWindowIo) {
  async function snapshot(input: { conversationId: string; limit?: number }, signal?: AbortSignal): Promise<TimelineSnapshot> {
    const request = await io.request(input.conversationId, input.limit, signal);
    return readWindowSnapshot(request);
  }
  async function readWindowSnapshot(request: WindowReadRequest): Promise<TimelineSnapshot> {
    const signal = request.signal;
    const value = project(page(await io.openRecent(request)));
    signal?.throwIfAborted();
    return value;
  }
  async function after(input: { conversationId: string; cursor: RecordCursor }, signal?: AbortSignal): Promise<TimelineAfterResult> {
    return afterPage(await snapshot(input, signal), input.cursor);
  }
  async function older(input: SessionpageSessionOlderRequest, signal?: AbortSignal): Promise<TimelineOlderResult> {
    if (!input.cursor) throw new Error('A window cursor is required for older history');
    const request = await io.request(input.conversationId, input.limit, signal);
    const value = page(await io.readOlder({ ...request, cursor: input.cursor }));
    signal?.throwIfAborted();
    const snapshot = project(value);
    const { cursor, settlements: _settlements, ...fields } = snapshot;
    return { ...fields, epoch: cursor.epoch };
  }
  async function body(input: SessionpageSessionBodyReadRequest, signal?: AbortSignal): Promise<WindowBodyResult> {
    const request = await io.request(input.conversationId, undefined, signal);
    if (input.bodyRef.scope !== request.scope) throw new Error('Body does not belong to this conversation');
    const value = await io.readBody({ ...request, ...input });
    signal?.throwIfAborted();
    return value;
  }
  async function subscribe(input: SessionpageSessionSubscribeRequest, emit: (event: SessionpageSessionEvent) => void,
    failed: (status: SessionpageSessionWindowStatusEvent) => void, signal?: AbortSignal,
    opening?: () => void): Promise<() => void> {
    const abort = new AbortController();
    let cursor = input.cursor, running = false, dirty = false, stopped = false;
    let stopWatch: (() => void) | undefined;
    let initialRequest: WindowReadRequest | undefined;
    const stop = () => { if (!stopped) { stopped = true; abort.abort(); stopWatch?.(); signal?.removeEventListener('abort', stop); } };
    const fail = (error: unknown) => {
      if (stopped) return;
      stop();
      const failure = error as { code?: string; message?: string } | null;
      failed({ conversationId: input.conversationId, subscriptionId: input.subscriptionId, state: 'failed',
        error: { code: failure?.code ?? 'record_unreadable', message: failure?.message ?? String(error) } });
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const pump = async () => {
      dirty = true;
      if (running || stopped) return;
      running = true;
      try {
        while (dirty && !stopped) {
          dirty = false;
          const request = initialRequest ?? await io.request(input.conversationId, undefined, abort.signal);
          initialRequest = undefined;
          const value = await readWindowSnapshot(request);
          if (stopped) return;
          opening?.();
          if (!value.pendingLongRecords?.length) opening = undefined;
          const result = afterPage(value, cursor);
          cursor = value.cursor;
          emit({ subscriptionId: input.subscriptionId, result });
        }
      } catch (error) { fail(error); }
      finally { running = false; }
    };
    try {
      abort.signal.throwIfAborted();
      opening?.();
      const request = await io.request(input.conversationId, undefined, abort.signal);
      initialRequest = request;
      stopWatch = await io.watch(input.conversationId, () => { void pump(); }, request, fail);
      opening?.();
      if (stopped) { stopWatch(); io.finish?.(request); }
      else void pump();
      return stop;
    } catch (error) { stop(); if (initialRequest) io.finish?.(initialRequest); throw error; }
  }
  return { snapshot, after, older, body, subscribe };
}
