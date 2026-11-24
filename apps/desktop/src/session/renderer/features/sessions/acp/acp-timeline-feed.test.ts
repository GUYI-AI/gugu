import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  snapshot: vi.fn(),
  subscribe: vi.fn(async () => ({ ok: true, value: { subscriptionId: 'sub' } })),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessionTimeline: { sessionSnapshot: host.snapshot, sessionSubscribe: host.subscribe, sessionUnsubscribe: async () => ({ ok: true, value: null }) } }),
  onMachineEvent: () => () => undefined,
}));

const { AcpTimelineFeed } = await import('./acp-timeline-feed');
const { RECORD_WAIT_RETRY_MS, RECORD_WAIT_WINDOW_MS } = await import('@/components/session-watch/record-wait');

const notYet = { ok: false, error: { code: 'record_not_found', message: '找不到 codex rollout 记录' } };
const written = { ok: true, value: { cursor: { epoch: 'e1', seq: 1 }, turns: [], settlements: [], hasOlder: false } };

describe('AcpTimelineFeed.open', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    host.snapshot.mockReset();
    host.subscribe.mockClear();
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
