import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  snapshot: vi.fn(),
  listen: vi.fn<(listener: (event: { result: unknown }) => void) => () => void>(() => () => undefined),
  subscribe: vi.fn(async () => ({ ok: true, value: { subscriptionId: 'sub' } })),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessionTimeline: { sessionSnapshot: host.snapshot, sessionSubscribe: host.subscribe, sessionUnsubscribe: async () => ({ ok: true, value: null }) } }),
  onMachineEvent: (_machine: unknown, _channel: unknown, listener: (event: { result: unknown }) => void) => host.listen(listener),
}));

const { AcpTimelineFeed } = await import('./acp-timeline-feed');
const { LOAD_RETRY_DELAYS_MS, RECORD_WAIT_RETRY_MS, RECORD_WAIT_WINDOW_MS } = await import('@/components/session-watch/record-wait');

const notYet = { ok: false, error: { code: 'record_not_found', message: '找不到 codex rollout 记录' } };
const written = { ok: true, value: { cursor: { epoch: 'e1', seq: 1 }, turns: [], settlements: [], hasOlder: false } };

describe('AcpTimelineFeed.open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.snapshot.mockReset();
    host.subscribe.mockClear();
    host.listen.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("waits for a new session's record instead of failing before the agent writes it", async () => {
    host.snapshot.mockResolvedValueOnce(notYet).mockResolvedValueOnce(notYet).mockResolvedValueOnce(written);
    const feed = new AcpTimelineFeed('conv-1', () => undefined, () => undefined);
    const opened = feed.open();
    await vi.advanceTimersByTimeAsync(RECORD_WAIT_RETRY_MS * 2);
    await opened;
    expect(host.snapshot).toHaveBeenCalledTimes(3);
    expect(feed.opened).toBe(true);
    expect(host.subscribe).toHaveBeenCalledOnce();
  });

  it('fails as before once the wait is over, and at once for any other failure', async () => {
    host.snapshot.mockResolvedValue(notYet);
    const feed = new AcpTimelineFeed('conv-1', () => undefined, () => undefined);
    const opened = feed.open();
    const failed = expect(opened).rejects.toMatchObject({ code: 'record_not_found' });
    await vi.advanceTimersByTimeAsync(RECORD_WAIT_WINDOW_MS + RECORD_WAIT_RETRY_MS);
    await failed;

    host.snapshot.mockReset();
    host.snapshot.mockResolvedValue({ ok: false, error: { code: 'session_not_found', message: 'gone' } });
    await expect(feed.open()).rejects.toMatchObject({ code: 'session_not_found' });
    expect(host.snapshot).toHaveBeenCalledOnce();
  });

  it('recovers and resubscribes when the replacement snapshot fails once', async () => {
    const replacement = { ...written, value: { ...written.value, cursor: { epoch: 'native', seq: 2 } } };
    const snapshotFault = { ok: false, error: { code: 'record_unreadable', message: 'temporary read failure' } };
    host.snapshot.mockResolvedValueOnce(written).mockResolvedValueOnce(snapshotFault).mockResolvedValueOnce(replacement);
    const failed = vi.fn();
    const feed = new AcpTimelineFeed('conv-1', () => undefined, failed);
    await feed.open();

    const push = host.listen.mock.calls[0]![0];
    push({ result: { ok: true, batch: { from: 0, cursor: { epoch: 'replaced', seq: 0 } } } });
    await vi.advanceTimersByTimeAsync(LOAD_RETRY_DELAYS_MS[0]!);

    expect(feed.state.cursor).toEqual(replacement.value.cursor);
    expect(host.snapshot).toHaveBeenCalledTimes(3);
    expect(host.subscribe).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
  });

  it('stops waiting when the page closes', async () => {
    host.snapshot.mockResolvedValue(notYet);
    const feed = new AcpTimelineFeed('conv-1', () => undefined, () => undefined);
    const opened = feed.open();
    await vi.advanceTimersByTimeAsync(0);
    feed.close();
    await vi.advanceTimersByTimeAsync(RECORD_WAIT_RETRY_MS);
    await opened;
    expect(host.snapshot).toHaveBeenCalledOnce();
    expect(host.subscribe).not.toHaveBeenCalled();
  });
});
