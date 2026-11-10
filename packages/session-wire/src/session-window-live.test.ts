import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  WINDOW_LIVE_PAGE_BYTES, WINDOW_LIVE_PAGE_ENTRIES,
  windowCommitPageSchema, windowCommitReferenceSchema, windowLiveAckRequestSchema,
  windowLiveAckResultSchema, windowLiveCursorSchema, windowLivePositionRequestSchema,
  windowLivePositionResponseSchema, windowLiveReadRequestSchema, windowLiveReadResultSchema,
  type WindowCommitReference, type WindowLiveApi, type WindowLiveCursor, type WindowLiveResult,
} from './session-window-live';

const cursor = (sequence: number): WindowLiveCursor => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence });
const owner = { conversationId: 'conversation', subscriptionId: 'fresh-uuid' };
const reference = (sequence = 1): Extract<WindowCommitReference, { kind: 'insert' }> => ({
  kind: 'insert', referenceId: `ref-${sequence}`, projectionId: 'projection', rowId: 'row', storedSeq: 7,
  firstCommitCursor: cursor(sequence), latestRevisionCursor: cursor(sequence),
});
const page = () => ({ entries: [reference()], next: cursor(1), hasMore: false });
const position = { projectionId: 'projection', rowId: 'row', storedSeq: 7, referenceId: 'ref-1' };

describe('window live public contract', () => {
  it('preserves the exact Prepare cursor and owner on all three requests', () => {
    const after = { ...cursor(19), workerEpoch: 'prepared-worker' };
    expect(windowLiveReadRequestSchema.parse({ ...owner, after })).toEqual({ ...owner, after });
    expect(windowLiveAckRequestSchema.parse({ ...owner, through: cursor(21) }).through).toEqual(cursor(21));
    expect(windowLivePositionRequestSchema.parse({ ...owner, referenceId: 'ref-1', appliedCursor: after })
      .appliedCursor).toEqual(after);
    for (const subscriptionId of ['', undefined]) {
      expect(windowLiveReadRequestSchema.safeParse({ ...owner, subscriptionId, after }).success).toBe(false);
    }
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects unsafe cursor sequence %s', sequence => {
    expect(windowLiveCursorSchema.safeParse(cursor(sequence)).success).toBe(false);
  });

  it('requires real insert proof but preserves null on historical updates', () => {
    expect(windowCommitReferenceSchema.safeParse({ ...reference(), firstCommitCursor: null }).success).toBe(false);
    expect(windowCommitReferenceSchema.safeParse({ ...reference(3), firstCommitCursor: cursor(2) }).success).toBe(false);
    const historical = { ...reference(3), kind: 'update', firstCommitCursor: null };
    expect(windowCommitReferenceSchema.parse(historical)).toEqual(historical);
    expect(windowCommitReferenceSchema.parse({ ...historical, firstCommitCursor: cursor(1) }).firstCommitCursor)
      .toEqual(cursor(1));
  });

  it('accepts a needs_location reference without a projection, and nothing else on it', () => {
    const { projectionId: _projection, ...located } = reference(3);
    const tooLarge = { ...located, kind: 'needs_location' };
    expect(windowCommitReferenceSchema.parse(tooLarge)).toEqual(tooLarge);
    expect(windowCommitReferenceSchema.parse({ ...tooLarge, firstCommitCursor: null })).toEqual({ ...tooLarge, firstCommitCursor: null });
    expect(windowCommitReferenceSchema.safeParse({ ...tooLarge, projectionId: 'p' }).success).toBe(false);
    expect(windowCommitReferenceSchema.safeParse({ ...tooLarge, firstCommitCursor: cursor(4) }).success).toBe(false);
  });

  it('rejects epoch mixing and revisions before the first commit', () => {
    for (const first of [{ ...cursor(1), storeEpoch: 'old-store' }, cursor(4)]) {
      expect(windowCommitReferenceSchema.safeParse({ ...reference(3), kind: 'update', firstCommitCursor: first })
        .success).toBe(false);
    }
  });

  it('validates the frozen page end without treating hasMore=false as end of subscription', () => {
    expect(windowLiveReadResultSchema.parse({ ok: true, value: page() })).toEqual({ ok: true, value: page() });
    for (const entries of [[], [reference(2), reference(1)], [reference(), reference()]]) {
      expect(windowCommitPageSchema.safeParse({ ...page(), entries }).success).toBe(false);
    }
    expect(windowCommitPageSchema.safeParse({ ...page(), next: cursor(2) }).success).toBe(false);
    expect(windowCommitPageSchema.safeParse({ ...page(), next: { ...cursor(1), storeEpoch: 'old' } }).success).toBe(false);
  });

  it('bounds reference count, scalar sizes and aggregate UTF8 bytes', () => {
    const entries = Array.from({ length: WINDOW_LIVE_PAGE_ENTRIES }, (_, i) => reference(i + 1));
    expect(windowCommitPageSchema.safeParse({ entries, next: cursor(8), hasMore: true }).success).toBe(true);
    expect(windowCommitPageSchema.safeParse({ entries: [...entries, reference(9)], next: cursor(9), hasMore: false })
      .success).toBe(false);
    expect(windowCommitReferenceSchema.safeParse({ ...reference(), referenceId: 'a'.repeat(2049) }).success).toBe(false);
    const unicode = entries.map(entry => ({ ...entry, referenceId: '界'.repeat(2048) }));
    expect(new TextEncoder().encode(JSON.stringify(unicode)).byteLength).toBeGreaterThan(WINDOW_LIVE_PAGE_BYTES);
    expect(windowCommitPageSchema.safeParse({ entries: unicode, next: cursor(8), hasMore: false }).success).toBe(false);
  });

  it('rejects turn/body payloads instead of copying them into a reference page', () => {
    expect(windowCommitPageSchema.safeParse({ ...page(), entries: [{ ...reference(), turn: { text: 'body' } }] })
      .success).toBe(false);
    expect(windowCommitPageSchema.safeParse({ ...page(), body: 'body' }).success).toBe(false);
    expect(windowLiveReadRequestSchema.safeParse({ ...owner, after: cursor(0), body: 'body' }).success).toBe(false);
  });

  it('keeps committed-without-insert-proof distinct from absence and needs_location', () => {
    const committed = { ok: true, value: { kind: 'committed', position, firstCommitCursor: null,
      latestRevisionCursor: cursor(3) } };
    expect(windowLivePositionResponseSchema.parse(committed)).toEqual(committed);
    const absent = { ok: true, value: { kind: 'not_committed', sampledCursor: cursor(3) } };
    expect(windowLivePositionResponseSchema.parse(absent)).toEqual(absent);
    const error = { ok: false, error: { code: 'needs_location', message: 'Descriptor is not durable' } };
    expect(windowLivePositionResponseSchema.parse(error)).toEqual(error);
    expect(windowLivePositionResponseSchema.safeParse({ ok: true, value: { ...absent.value, position } }).success).toBe(false);
  });

  it('keeps domain results separate from success/data and transport result envelopes', () => {
    expect(windowLiveAckResultSchema.parse({ ok: true, value: undefined })).toEqual({ ok: true, value: undefined });
    expect(windowLiveAckResultSchema.safeParse({ success: true, data: undefined }).success).toBe(false);
    expect(windowLiveReadResultSchema.safeParse({ kind: 'result', id: 'rpc', ok: true, value: page() }).success).toBe(false);
    expectTypeOf<ReturnType<WindowLiveApi['ack']>>().toEqualTypeOf<Promise<WindowLiveResult<void>>>();
    expectTypeOf<Extract<WindowCommitReference, { kind: 'insert' }>['firstCommitCursor']>()
      .toEqualTypeOf<WindowLiveCursor>();
    expectTypeOf<Extract<WindowCommitReference, { kind: 'update' }>['firstCommitCursor']>()
      .toEqualTypeOf<WindowLiveCursor | null>();
  });
});
