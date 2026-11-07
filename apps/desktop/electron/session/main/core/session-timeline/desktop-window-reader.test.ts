import { describe, expect, it, vi } from 'vitest';
import { createDesktopWindowReader, type DesktopWindowIo } from './desktop-window-reader';
import { createWindowBudget } from '../../../../../../../packages/session-core/src/session-record/window-cache/read-budget';
import type { WindowPage } from '../../../../../../../packages/session-core/src/session-record/window-cache/types';
import { applySnapshot, applyTimelineResult, emptyAgentWatchTimeline } from '../../../../../src/mobile/agent-watch/agent-watch-store';

function setup() {
  const value: WindowPage = { kind: 'continuation', scope: 'scope', sourceLineage: 'lineage', snapshotRevision: 'rev',
    commitSeq: 0, turns: [], bodyRefs: [], coveredRanges: [], olderCursor: null, moreBefore: 'unknown',
    pendingLongRecords: [{ kind: 'pending_long_record', ticket: 'ticket', sourceInstance: 'instance', pinnedEnd: 20 * 1024 ** 3,
      nextScanOffset: 100, sourceFence: { start: 100, end: 101, digest: 'digest' } }],
    io: createWindowBudget().counters };
  let changed = () => {};
  const stopped = vi.fn();
  const io: DesktopWindowIo = {
    request: vi.fn<DesktopWindowIo['request']>(async (conversationId, limit, signal) => ({ conversationId, limit, signal,
      locator: { harness: 'codex', providerSessionId: 'native', roots: [] }, cacheDirectory: '/unused',
      scope: 'scope', conversationScope: 'conversation', branchLineage: 'branch', budget: createWindowBudget() })),
    openRecent: vi.fn(async () => value), readOlder: vi.fn(async () => value),
    readBody: vi.fn<DesktopWindowIo['readBody']>(async request => ({ kind: 'needs_location', bodyId: request.bodyRef.id, revision: request.bodyRef.revision, offset: request.offset, io: request.budget.counters })),
    watch: vi.fn(async (_id, notify) => { changed = notify; return stopped; }),
  };
  return { reader: createDesktopWindowReader(io), io, value, changed: () => changed(), stopped };
}

describe('desktop bounded window bridge', () => {
  it('preserves pending state and never reports an unknown prefix as complete', async () => {
    const { reader, io, value } = setup();
    const snapshot = await reader.snapshot({ conversationId: 'session' });
    expect(snapshot.pendingLongRecords).toEqual(value.pendingLongRecords);
    expect(snapshot.hasOlder).toBe(true);
    expect(snapshot.cursor.seq).toBe(20 * 1024 ** 3);
    expect(io.openRecent).toHaveBeenCalledTimes(1);
  });
  it('passes cursor-only older reads and the exact request-wide budget to the reader', async () => {
    const { reader, io } = setup();
    const cursor = { version: 1 as const, scope: 'scope', sourceLineage: 'lineage', snapshotRevision: 'rev', before: 100, segment: null };
    const result = await reader.older({ conversationId: 'session', cursor });
    expect(result.epoch).toBe('lineage:rev');
    expect(vi.mocked(io.readOlder).mock.calls[0][0].cursor).toBe(cursor);
    const request = await vi.mocked(io.request).mock.results[0].value;
    expect(vi.mocked(io.readOlder).mock.calls[0][0].budget).toBe(request.budget);
  });
  it('after carries explicit empty pending arrays instead of retaining resolved tickets', async () => {
    const { reader, value } = setup();
    value.pendingLongRecords = [];
    const result = await reader.after({ conversationId: 'session', cursor: { epoch: 'lineage:rev', seq: 0 } });
    if (!result.ok) throw new Error('Expected batch');
    expect(result.batch.pendingLongRecords).toEqual([]);
  });
  it('subscription discards a late read after unsubscribe and releases the revision watcher', async () => {
    const { reader, io, stopped } = setup();
    let resolve!: (value: WindowPage) => void;
    vi.mocked(io.openRecent).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const emit = vi.fn(), failed = vi.fn();
    const stop = await reader.subscribe({ conversationId: 'session', subscriptionId: 'sub', cursor: null }, emit, failed);
    await vi.waitFor(() => expect(io.openRecent).toHaveBeenCalledTimes(1));
    stop();
    resolve(setup().value);
    await Promise.resolve(); await Promise.resolve();
    expect(emit).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled(); expect(stopped).toHaveBeenCalledOnce();
  });
  it('replaces the actual shared consumer window after a same-size source rewrite', async () => {
    const { reader, value } = setup();
    value.pendingLongRecords = []; value.coveredRanges = [{ start: 0, end: 100 }];
    value.turns = [{ id: 'old', seq: 1, initiator: 'agent', items: [] }];
    const initial = await reader.snapshot({ conversationId: 'session' });
    let state = applySnapshot(emptyAgentWatchTimeline(), initial);
    value.snapshotRevision = 'rewritten';
    value.turns = [{ id: 'replacement', seq: 1, initiator: 'agent', items: [] }];
    const result = await reader.after({ conversationId: 'session', cursor: initial.cursor });
    expect(result.ok).toBe(false);
    state = applyTimelineResult(state, result);
    expect(state.turns.map(turn => turn.id)).toEqual(['replacement']);
  });
});
