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
const snapshot = { cursor: { epoch: 'e1', seq: 1 }, turns: [], settlements: [], hasOlder: false };
function push(event: SessionpageSessionEvent | SessionpageRecordStatusEvent) {
  const name = 'result' in event ? 'session-timeline:push' : 'session-record:status';
  host.listeners.get(`${name}.${event.subscriptionId}`)?.(event);
}
describe('local Codex event-driven history', () => {
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
  it('stays subscribed while the file is absent and opens on the readiness push', async () => {
    const feed = new AcpTimelineFeed('S', vi.fn(), vi.fn(), () => true);
    const opening = feed.open();
    const id = host.subscribe.mock.calls[0][0].subscriptionId;
    push({ subscriptionId: id, waiting: true });
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
