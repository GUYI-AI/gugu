import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionEvent, SessionpageRecordStatusEvent } from '@gugu/session-core/session-record/contract';

const host = vi.hoisted(() => ({ snapshot: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), listeners: new Map<string, (event: unknown) => void>() }));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessionTimeline: { sessionSnapshot: host.snapshot, sessionSubscribe: host.subscribe, sessionUnsubscribe: host.unsubscribe } }),
  onMachineEvent: (_: unknown, channel: { name: string }, receive: (event: unknown) => void) => {
    host.listeners.set(channel.name, receive);
    return () => host.listeners.delete(channel.name);
  },
}));
const { AcpTimelineFeed } = await import('./acp-timeline-feed');
const { LOAD_RETRY_DELAYS_MS } = await import('@/components/session-watch/record-wait');
const snapshot = { cursor: { epoch: 'e1', seq: 1 }, turns: [], settlements: [], hasOlder: false };
function push(event: SessionpageSessionEvent | SessionpageRecordStatusEvent) {
  const name = 'result' in event ? 'session-timeline:push' : 'session-record:status';
  host.listeners.get(`${name}.${event.subscriptionId}`)?.(event);
}
function pushGap(subscriptionId: string) {
  push({ subscriptionId, result: {
    ok: true,
    batch: { from: 2, cursor: { epoch: 'e1', seq: 3 }, turns: [], removedTurnIds: [], settlements: [] },
  } });
}
describe('local session history', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.listeners.clear();
    host.snapshot.mockReset();
    host.unsubscribe.mockReset().mockResolvedValue(undefined);
    host.subscribe.mockReset().mockResolvedValue({ ok: true, value: { subscriptionId: 'sub' } });
  });
  afterEach(() => vi.useRealTimers());
  it('subscribes before reading, accepts a snapshot before the acknowledgement, and never starts a retry clock', async () => {
    host.subscribe.mockImplementation(async (input) => {
      push({ subscriptionId: input.subscriptionId, result: { ok: false, reset: 'epoch_changed', snapshot } });
      return { ok: true, value: { subscriptionId: input.subscriptionId } };
    });
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn(), () => true);
    await feed.open();
    expect(feed.opened).toBe(true);
    expect(host.snapshot).not.toHaveBeenCalled();
    expect(host.subscribe).toHaveBeenCalledWith(expect.objectContaining({ cursor: null, recordEvents: true }));
    expect(vi.getTimerCount()).toBe(0);
    feed.close();
  });
  it('stays subscribed, asking for nothing again, until the host pushes the first snapshot', async () => {
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn(), () => true);
    const opening = feed.open();
    const id = host.subscribe.mock.calls[0][0].subscriptionId;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feed.opened).toBe(false);
    expect(host.subscribe).toHaveBeenCalledOnce();
    push({ subscriptionId: id, result: { ok: false, reset: 'epoch_changed', snapshot } });
    await opening;
    expect(feed.opened).toBe(true);
    expect(host.snapshot).not.toHaveBeenCalled();
    feed.close();
  });
  it('exposes the host deadline failure without another read or subscription', async () => {
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn(), () => true);
    const opening = feed.open();
    const failed = expect(opening).rejects.toMatchObject({ code: 'record_not_found' });
    push({ subscriptionId: host.subscribe.mock.calls[0][0].subscriptionId, error: { code: 'record_not_found', message: '记录没出现' } });
    await failed;
    expect(host.subscribe).toHaveBeenCalledOnce();
    expect(host.snapshot).not.toHaveBeenCalled();
    expect(host.listeners.size).toBe(0);
  });
  it('close settles an outstanding open and ignores a late snapshot', async () => {
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn(), () => true);
    const opening = feed.open();
    const id = host.subscribe.mock.calls[0][0].subscriptionId;
    feed.close();
    await opening;
    push({ subscriptionId: id, result: { ok: false, reset: 'epoch_changed', snapshot } });
    expect(feed.opened).toBe(false);
    expect(host.listeners.size).toBe(0);
    expect(host.unsubscribe).toHaveBeenCalledWith({ subscriptionId: id });
  });
  it('reopens on a gap through the Codex readiness subscription', async () => {
    host.subscribe.mockImplementationOnce(async (input) => {
      push({ subscriptionId: input.subscriptionId, result: { ok: false, reset: 'epoch_changed', snapshot } });
      return { ok: true, value: { subscriptionId: input.subscriptionId } };
    });
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn(), () => true);
    await feed.open();
    const firstId = host.subscribe.mock.calls[0][0].subscriptionId;
    pushGap(firstId);

    expect(host.unsubscribe).toHaveBeenCalledWith({ subscriptionId: firstId });
    expect(host.subscribe).toHaveBeenCalledTimes(2);
    const next = host.subscribe.mock.calls[1][0];
    expect(next).toMatchObject({ cursor: null, recordEvents: true });
    expect(next.subscriptionId).not.toBe(firstId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(feed.state.cursor).toEqual(snapshot.cursor);
    expect(host.snapshot).not.toHaveBeenCalled();
    expect(host.subscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    const recovered = { ...snapshot, cursor: { epoch: 'e1', seq: 3 } };
    push({ subscriptionId: next.subscriptionId, result: { ok: false, reset: 'epoch_changed', snapshot: recovered } });
    expect(feed.state.cursor).toEqual(recovered.cursor);
    feed.close();
  });
  it('recovers and resubscribes when the replacement snapshot fails once', async () => {
    const replacement = { ...snapshot, cursor: { epoch: 'native', seq: 2 } };
    const snapshotFault = { ok: false, error: { code: 'record_unreadable', message: 'temporary read failure' } };
    host.snapshot.mockResolvedValueOnce({ ok: true, value: snapshot })
      .mockResolvedValueOnce(snapshotFault)
      .mockResolvedValueOnce({ ok: true, value: replacement });
    const failed = vi.fn();
    const feed = new AcpTimelineFeed('S', vi.fn(), failed);
    await feed.open();
    pushGap(host.subscribe.mock.calls[0][0].subscriptionId);
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.state.cursor).toEqual(snapshot.cursor);

    await vi.advanceTimersByTimeAsync(LOAD_RETRY_DELAYS_MS[0]!);
    expect(feed.state.cursor).toEqual(replacement.cursor);
    expect(host.snapshot).toHaveBeenCalledTimes(3);
    expect(host.subscribe).toHaveBeenCalledTimes(2);
    expect(host.subscribe.mock.lastCall?.[0]).toMatchObject({ cursor: replacement.cursor });
    expect(failed).not.toHaveBeenCalled();
    feed.close();
  });
  it('retains the existing bounded record_not_found wait for non-Codex providers', async () => {
    host.snapshot.mockResolvedValueOnce({ ok: false, error: { code: 'record_not_found', message: 'not written' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'record_not_found', message: 'not written' } })
      .mockResolvedValueOnce({ ok: true, value: snapshot });
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn());
    const opening = feed.open();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(host.subscribe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await opening;
    expect(feed.opened).toBe(true);
    expect(host.snapshot).toHaveBeenCalledTimes(3);
    expect(host.subscribe.mock.calls[0][0].recordEvents).toBeUndefined();
    feed.close();
  });
  it('keeps the ordinary snapshot path for other providers', async () => {
    host.snapshot.mockResolvedValue({ ok: true, value: snapshot });
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn());
    await feed.open();
    expect(host.snapshot).toHaveBeenCalledOnce();
    expect(host.subscribe.mock.calls[0][0].recordEvents).toBeUndefined();
    feed.close();
  });
});
