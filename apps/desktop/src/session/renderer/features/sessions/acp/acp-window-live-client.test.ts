import { describe, expect, it, vi } from 'vitest';
import type { WindowCommitPage, WindowLiveApi, WindowLiveCursor, WindowLivePositionResult } from '@gugu/session-wire/session-window-live';
import { createAcpWindowLiveClient } from './acp-window-live-client';
import { startAcpWindowCommitReader } from './acp-window-commit-reader';

const at = (sequence: number): WindowLiveCursor => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence });
function page(sequence: number): WindowCommitPage {
  return { entries: [{ kind: 'insert', referenceId: `ref-${sequence}`, projectionId: `projection-${sequence}`, rowId: `row-${sequence}`,
    storedSeq: sequence, firstCommitCursor: at(sequence), latestRevisionCursor: at(sequence) }], next: at(sequence), hasMore: false };
}
function fixture() {
  const owner = { conversationId: 'conversation', subscriptionId: 'opening' };
  const api = { read: vi.fn<WindowLiveApi['read']>(), ack: vi.fn<WindowLiveApi['ack']>(), position: vi.fn<WindowLiveApi['position']>() };
  let active = true;
  return { owner, api, client: createAcpWindowLiveClient(owner, api, () => active), close: () => { active = false; } };
}

describe('public committed-history client', () => {
  it('snapshots the same opening owner and exact Prepare cursor before awaiting, and freezes the delivered page', async () => {
    const f = fixture(), after = at(3), pending = Promise.withResolvers<Awaited<ReturnType<WindowLiveApi['read']>>>();
    f.api.read.mockReturnValue(pending.promise);
    const read = f.client.read(after);
    after.sequence = 99; f.owner.subscriptionId = 'another-opening';
    expect(f.api.read).toHaveBeenCalledWith({ conversationId: 'conversation', subscriptionId: 'opening', after: at(3) });
    pending.resolve({ ok: true, value: page(4) });
    const result = await read;
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.entries[0])).toBe(true);
    expect(Object.isFrozen(result.next)).toBe(true); expect(Object.isFrozen(result.entries[0].latestRevisionCursor)).toBe(true);
  });

  it.each(['workerEpoch', 'storeEpoch'] as const)('rejects a page from another %s', async field => {
    const f = fixture(), value = page(4);
    value.next[field] = 'other'; value.entries[0].latestRevisionCursor[field] = 'other'; value.entries[0].firstCommitCursor![field] = 'other';
    f.api.read.mockResolvedValue({ ok: true, value });
    await expect(f.client.read(at(3))).rejects.toMatchObject({ code: 'invalid_live_response' });
  });

  it('rejects an already applied page and a body-bearing response rather than passing them to materialization', async () => {
    const f = fixture();
    f.api.read.mockResolvedValueOnce({ ok: true, value: page(3) });
    await expect(f.client.read(at(3))).rejects.toMatchObject({ code: 'invalid_live_response' });
    f.api.read.mockResolvedValueOnce({ ok: true, value: { ...page(4), body: 'unexpected payload' } } as never);
    await expect(f.client.read(at(3))).rejects.toMatchObject({ code: 'invalid_live_response' });
    expect(f.api.ack).not.toHaveBeenCalled();
  });

  it('preserves historical update-only null proof in a delivered page', async () => {
    const f = fixture(), value = page(4);
    const [inserted] = value.entries;
    if (inserted.kind !== 'insert') throw new Error('fixture must start from an insert');
    value.entries = [{ ...inserted, kind: 'update', firstCommitCursor: null }];
    f.api.read.mockResolvedValue({ ok: true, value });
    expect((await f.client.read(at(3))).entries[0]).toMatchObject({ kind: 'update', firstCommitCursor: null });
  });

  it('unwraps structured Read and ACK failures once, with no replacement request', async () => {
    const f = fixture(), error = { code: 'live_source_gap', message: 'Committed continuity was lost' };
    f.api.read.mockResolvedValue({ ok: false, error }); f.api.ack.mockResolvedValue({ ok: false, error });
    await expect(f.client.read(at(3))).rejects.toMatchObject(error);
    await expect(f.client.ack(at(4))).rejects.toMatchObject(error);
    expect(f.api.read).toHaveBeenCalledTimes(1); expect(f.api.ack).toHaveBeenCalledTimes(1);
    expect(f.api.ack).toHaveBeenCalledWith({ conversationId: 'conversation', subscriptionId: 'opening', through: at(4) });
  });

  it('rejects an invalid successful ACK instead of advancing a cursor', async () => {
    const f = fixture(); f.api.ack.mockResolvedValue({ ok: true, value: 'not-void' } as never);
    await expect(f.client.ack(at(4))).rejects.toMatchObject({ code: 'invalid_live_response' });
  });

  it('keeps committed null-first distinct from a real not-committed sample and from needs_location', async () => {
    const f = fixture();
    const committed: WindowLivePositionResult = { kind: 'committed', position: { referenceId: 'old-ref', projectionId: 'old-projection', rowId: 'old-row', storedSeq: 1 },
      firstCommitCursor: null, latestRevisionCursor: at(10) };
    f.api.position.mockResolvedValueOnce({ ok: true, value: committed });
    expect(await f.client.position('old-ref', at(8))).toEqual(committed);
    f.api.position.mockResolvedValueOnce({ ok: true, value: { kind: 'not_committed', sampledCursor: at(10) } });
    expect(await f.client.position('new-ref', at(8))).toEqual({ kind: 'not_committed', sampledCursor: at(10) });
    f.api.position.mockResolvedValueOnce({ ok: false, error: { code: 'needs_location', message: 'The durable descriptor is unavailable' } });
    await expect(f.client.position('pending-ref', at(8))).rejects.toMatchObject({ code: 'needs_location' });
    expect(f.api.position).toHaveBeenCalledTimes(3);
  });

  it.each(['reference', 'epoch', 'old-sample'] as const)('rejects an unrelated Position result: %s', async kind => {
    const f = fixture();
    const value: WindowLivePositionResult = kind === 'reference' ? { kind: 'committed', position: {
      referenceId: 'another-ref', projectionId: 'p', rowId: 'r', storedSeq: 1 }, firstCommitCursor: null, latestRevisionCursor: at(10) }
      : { kind: 'not_committed', sampledCursor: kind === 'epoch' ? { ...at(10), workerEpoch: 'old-worker' } : at(7) };
    f.api.position.mockResolvedValue({ ok: true, value });
    await expect(f.client.position('wanted-ref', at(8))).rejects.toMatchObject({ code: 'invalid_live_response' });
  });

  it.each(['read', 'ack', 'position'] as const)('rejects a late %s result after its opening is released', async method => {
    const f = fixture(), pending = Promise.withResolvers<never>();
    f.api[method].mockReturnValue(pending.promise);
    const response = method === 'read' ? f.client.read(at(3)) : method === 'ack' ? f.client.ack(at(4)) : f.client.position('ref', at(3));
    f.close(); pending.resolve({ ok: false, error: { code: 'old-error', message: 'Old opening' } } as never);
    await expect(response).rejects.toMatchObject({ code: 'unsubscribed' });
  });

  it('does not issue any RPC after its opening has been released', async () => {
    const f = fixture(); f.close();
    await expect(f.client.read(at(3))).rejects.toMatchObject({ code: 'unsubscribed' });
    await expect(f.client.ack(at(4))).rejects.toMatchObject({ code: 'unsubscribed' });
    await expect(f.client.position('ref', at(3))).rejects.toMatchObject({ code: 'unsubscribed' });
    expect(f.api.read).not.toHaveBeenCalled(); expect(f.api.ack).not.toHaveBeenCalled(); expect(f.api.position).not.toHaveBeenCalled();
  });

  it('composes the public decoder with the real reader: rejected wire data cannot materialize or ACK', async () => {
    const f = fixture(), materialize = vi.fn(), commit = vi.fn(), failed = vi.fn(), release = vi.fn(f.close);
    f.api.read.mockResolvedValue({ ok: false, error: { code: 'live_source_gap', message: 'Gap' } });
    const reader = startAcpWindowCommitReader(at(3), { read: f.client.read, cursor: value => value.next,
      materialize, commit, ack: f.client.ack, release, failed });
    await reader.completed;
    expect(materialize).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(f.api.ack).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'live_source_gap' }));
    expect(release).toHaveBeenCalledTimes(1); expect(f.api.read).toHaveBeenCalledTimes(1);
  });
});
