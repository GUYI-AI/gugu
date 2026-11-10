import { describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionWindowStatusEvent, TimelineAfterResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract';
import { AcpWindowHistory, type AcpWindowHistoryClient } from './acp-window-history';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function snapshot(text = 'real bounded body', epoch = 'source'): TimelineAfterResult {
  return { ok: false, reset: 'epoch_changed', snapshot: {
    cursor: { epoch, seq: 0 }, turns: [], settlements: [], hasOlder: false,
    sourceLineage: 'native-source', snapshotRevision: epoch,
    sourceFragments: [{ key: 'native-record', ownership: 'unresolved',
      sourceRange: { start: 100, end: 200 }, knownRole: 'assistant', text }],
  } };
}
function batch(from: number, seq: number): TimelineAfterResult {
  return { ok: true, batch: { from, cursor: { epoch: 'source', seq }, turns: [], removedTurnIds: [], settlements: [] } };
}
const failure = (message: string) => ({ code: 'record_unreadable', message });
function fixture(conversationId = 'local-conversation') {
  const listeners: Array<{
    receive: (result: TimelineAfterResult, subscriptionId?: string) => void;
    failed: (error: SessionpageSessionWindowStatusEvent['error'], target?: { conversationId?: string; subscriptionId?: string }) => void;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const setups: ReturnType<typeof deferred>[] = [];
  const client = {
    listen: vi.fn<AcpWindowHistoryClient['listen']>((conversation, id, receive, failed) => {
      const stop = vi.fn();
      listeners.push({ stop, receive: (result, subscriptionId = id) => receive({ subscriptionId, result }),
        failed: (error, target = {}) => failed({ conversationId: conversation, subscriptionId: id, ...target, state: 'failed', error }) });
      return stop;
    }),
    subscribe: vi.fn<AcpWindowHistoryClient['subscribe']>(() => { const setup = deferred(); setups.push(setup); return setup.promise; }),
    unsubscribe: vi.fn<AcpWindowHistoryClient['unsubscribe']>(async () => undefined),
  };
  let id = 0;
  const changed = vi.fn();
  const history = new AcpWindowHistory(conversationId, client, changed, () => `opening-${++id}`);
  return { history, client, listeners, setups, changed };
}

describe('ACP bounded first-screen subscription owner', () => {
  it('listens first and paints the host snapshot even before the subscribe ACK, without another snapshot read', async () => {
    const f = fixture();
    const opening = f.history.open();
    expect(f.client.listen).toHaveBeenCalledWith('local-conversation', 'opening-1', expect.any(Function), expect.any(Function));
    expect(f.client.listen.mock.invocationCallOrder[0]).toBeLessThan(f.client.subscribe.mock.invocationCallOrder[0]!);
    expect(f.history.view.phase).toBe('loading');
    f.listeners[0]!.receive(snapshot());
    expect(f.history.view).toMatchObject({ phase: 'ready', timeline: { turns: [], sourceFragments: [{ text: 'real bounded body' }] } });
    f.setups[0]!.resolve(); await opening;
    expect(f.client.subscribe).toHaveBeenCalledTimes(1);
    expect(f.history.view.timeline.turns).toEqual([]); // A readable fragment is never a fabricated canonical turn.
    f.history.close(); await Promise.resolve();
  });

  it('does not call a setup ACK an empty successful history', async () => {
    const f = fixture(); const opening = f.history.open();
    f.setups[0]!.resolve(); await opening;
    expect(f.history.view.phase).toBe('loading');
    f.history.close();
  });

  it('creates a different real UUID for each production-default opening', async () => {
    const f = fixture();
    const history = new AcpWindowHistory('conversation', f.client, () => undefined);
    const first = history.open(); const second = history.open();
    const ids = f.client.subscribe.mock.calls.map(([, id]) => id);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(ids[1]).not.toBe(ids[0]);
    f.setups.forEach(setup => setup.resolve()); await Promise.all([first, second]);
    history.close();
  });

  it('can fail while the listener is being installed without leaving a listener or starting another read', async () => {
    const f = fixture(); const stop = vi.fn();
    f.client.listen.mockImplementationOnce((conversationId, subscriptionId, _receive, failed) => {
      failed({ conversationId, subscriptionId, state: 'failed', error: failure('already failed') });
      return stop;
    });
    await f.history.open();
    expect(f.history.view.phase).toBe('failed');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(f.client.subscribe).not.toHaveBeenCalled();
  });

  it.each(['setup', 'after-paint'])('does not silently retry %s failures after the old retry intervals', async stage => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const opening = f.history.open();
      if (stage === 'setup') f.setups[0]!.reject(failure('setup'));
      else { f.listeners[0]!.receive(snapshot()); f.listeners[0]!.failed(failure('stream')); f.setups[0]!.resolve(); }
      await opening; await vi.advanceTimersByTimeAsync(60_000);
      expect(f.history.view.phase).toBe('failed');
      expect(f.client.subscribe).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('turns setup rejection into one terminal failure, without retrying', async () => {
    const f = fixture(); const opening = f.history.open();
    const error = Object.assign(new Error('source unreadable'), { code: 'record_unreadable' });
    f.setups[0]!.reject(error); await opening;
    expect(f.history.view).toMatchObject({ phase: 'failed', error });
    expect(f.changed.mock.calls.filter(([view]) => view.phase === 'failed')).toHaveLength(1);
    expect(f.client.subscribe).toHaveBeenCalledTimes(1);
    expect(f.listeners[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('preserves already painted body on typed failure and rejects every later event from that opening', async () => {
    const f = fixture(); const opening = f.history.open();
    f.listeners[0]!.receive(snapshot());
    const painted = f.history.view.timeline;
    const error = failure('failed after first paint');
    f.listeners[0]!.failed(error);
    f.listeners[0]!.receive(snapshot('late body'));
    f.listeners[0]!.failed(failure('duplicate failed'));
    f.setups[0]!.resolve(); await opening;
    expect(f.history.view).toEqual({ phase: 'failed', error, timeline: painted });
    expect(f.changed.mock.calls.filter(([view]) => view.phase === 'failed')).toHaveLength(1);
    expect(f.client.subscribe).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh subscription on explicit reopen and ignores old results and failures', async () => {
    const f = fixture(); const old = f.history.open();
    f.listeners[0]!.receive(snapshot('old'));
    const current = f.history.open();
    f.listeners[1]!.receive(snapshot('current', 'current-epoch'));
    f.listeners[0]!.receive(snapshot('late old'));
    f.listeners[0]!.failed(failure('old setup failed'));
    f.setups[0]!.reject(new Error('late rejected ACK')); f.setups[1]!.resolve();
    await Promise.all([old, current]);
    expect(f.client.subscribe.mock.calls).toEqual([['local-conversation', 'opening-1'], ['local-conversation', 'opening-2']]);
    expect(f.history.view).toMatchObject({ phase: 'ready', error: null, timeline: { sourceFragments: [{ text: 'current' }] } });
    f.history.close();
  });

  it('releases a subscription whose successful setup ACK arrives after close', async () => {
    const f = fixture(); const opening = f.history.open();
    f.history.close(); await Promise.resolve();
    expect(f.client.unsubscribe).toHaveBeenCalledWith('opening-1');
    f.setups[0]!.resolve(); await opening; await Promise.resolve();
    expect(f.client.unsubscribe.mock.calls).toEqual([['opening-1'], ['opening-1']]);
    const count = f.changed.mock.calls.length;
    f.listeners[0]!.receive(snapshot()); f.listeners[0]!.failed(failure('old'));
    expect(f.changed).toHaveBeenCalledTimes(count);
  });

  it('replaces source metadata on a real host reset, keeping canonical history empty', async () => {
    const f = fixture(); const opening = f.history.open();
    f.listeners[0]!.receive(snapshot('before'));
    f.listeners[0]!.receive(snapshot('after', 'new-source'));
    f.setups[0]!.resolve(); await opening;
    expect(f.history.view.timeline).toMatchObject({ cursor: { epoch: 'new-source' }, sourceFragments: [{ text: 'after' }], turns: [] });
    expect(f.history.view.timeline.sourceFragments).toHaveLength(1);
    f.history.close();
  });

  it('ignores successes for a different subscription, even when delivered to the current listener', async () => {
    const f = fixture(); const opening = f.history.open();
    f.listeners[0]!.receive(snapshot('wrong subscription'), 'other-opening');
    f.setups[0]!.resolve(); await opening;
    expect(f.history.view.phase).toBe('loading');
    expect(f.history.view.timeline.sourceFragments).toBeUndefined();
    f.history.close();
  });

  it.each([{ conversationId: 'another-conversation' }, { subscriptionId: 'another-subscription' }])(
    'rejects failed events with the wrong owner %j', async target => {
      const f = fixture(); const opening = f.history.open();
      f.listeners[0]!.receive(snapshot());
      f.listeners[0]!.failed(failure('not this window'), target);
      f.setups[0]!.resolve(); await opening;
      expect(f.history.view).toMatchObject({ phase: 'ready', error: null });
      f.history.close();
    });

  it.each(['no first snapshot', 'missing identity', 'gap'] as const)('fails explicitly on %s instead of fetching or switching history source', async mode => {
    const f = fixture(); const opening = f.history.open();
    if (mode === 'gap') f.listeners[0]!.receive(snapshot());
    const result = mode === 'missing identity' ? snapshot() : batch(mode === 'gap' ? 9 : 0, 10);
    if (!result.ok) delete result.snapshot.sourceLineage;
    f.listeners[0]!.receive(result);
    f.setups[0]!.resolve(); await opening;
    expect(f.history.view.phase).toBe('failed');
    expect(f.history.view.error).toMatchObject({ code: 'invalid_window' });
    expect(f.client.subscribe).toHaveBeenCalledTimes(1);
  });

  it('accepts a verified empty source snapshot while pending tickets remain independent loading facts', async () => {
    const f = fixture(); const opening = f.history.open();
    const empty: TimelineSnapshot = { cursor: { epoch: 'source', seq: 0 }, turns: [], settlements: [], hasOlder: false,
      sourceLineage: 'source', snapshotRevision: 'revision', sourceFragments: [],
      pendingLongRecords: [{ kind: 'pending_long_record', ticket: 'unknown', sourceInstance: 'file',
        pinnedEnd: 500, nextScanOffset: 400, sourceFence: { start: 400, end: 500, digest: 'fence' } }] };
    f.listeners[0]!.receive({ ok: false, reset: 'epoch_changed', snapshot: empty });
    f.setups[0]!.resolve(); await opening;
    expect(f.history.view).toMatchObject({ phase: 'ready', timeline: { turns: [], sourceFragments: [], pendingLongRecords: [{ ticket: 'unknown' }] } });
    f.history.close();
  });
});
