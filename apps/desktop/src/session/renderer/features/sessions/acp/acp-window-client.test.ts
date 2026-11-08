import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionpageSessionEvent, SessionpageSessionWindowStatusEvent } from '@gugu/session-core/session-record/contract';

const wire = vi.hoisted(() => ({
  invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (value: unknown) => void>(),
  stop: vi.fn(),
}));
// Keep the real RPC proxy, event-topic fanout, public channels and adapter.
// Only the Electron boundary is simulated; no application window is claimed.
vi.mock('@renderer/lib/ipc', async () => {
  const { createRPCClient } = await import('@shared/lib/ipc/rpc');
  const { createEventEmitter } = await import('@shared/lib/ipc/events');
  return {
    rpcOn: () => createRPCClient(wire.invoke),
    events: createEventEmitter({ emit: () => {}, on: (name, receive) => {
      wire.listeners.set(name, receive);
      return () => { wire.listeners.delete(name); wire.stop(name); };
    } }),
  };
});
import { AcpWindowHistory } from './acp-window-history';
import { acpWindowHistoryClient, prepareAcpWindowHistory, startAcpWindowCommitIpc } from './acp-window-client';
import type { WindowCommitPage, WindowLiveCursor } from '@gugu/session-wire/session-window-live';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach(close => close());
  vi.clearAllMocks();
});
function fixture() {
  const changed = vi.fn();
  const history = new AcpWindowHistory('conversation', acpWindowHistoryClient, changed, () => 'subscription');
  cleanups.push(() => history.close());
  wire.invoke.mockImplementation(async () => undefined);
  return { history, changed };
}
function emitBody() {
  const event: SessionpageSessionEvent = { subscriptionId: 'subscription', result: {
    ok: false, reset: 'epoch_changed', snapshot: {
      cursor: { epoch: 'source', seq: 0 }, turns: [], settlements: [], hasOlder: false,
      sourceLineage: 'file', snapshotRevision: 'revision',
      sourceFragments: [{ key: 'record', ownership: 'unresolved', sourceRange: { start: 0, end: 100 }, text: 'Historical body' }],
    },
  } };
  wire.listeners.get('session-timeline:push.subscription')!(event);
}
const fail = { code: 'record_unreadable', message: 'The source could not be read' };
const at = (sequence: number): WindowLiveCursor => ({ workerEpoch: 'actual-worker', storeEpoch: 'actual-store', sequence });
function livePage(sequence: number): WindowCommitPage {
  return { entries: [{ kind: 'insert', referenceId: `ref-${sequence}`, projectionId: `projection-${sequence}`, rowId: `row-${sequence}`,
    storedSeq: sequence, firstCommitCursor: at(sequence), latestRevisionCursor: at(sequence) }], next: at(sequence), hasMore: false };
}

describe('ACP window IPC binding', () => {
  it.each(['window', 'legacy'] as const)('prepares the %s source without invoking a history reader', async source => {
    const choice = source === 'legacy' ? { source } : { source, liveCursor: at(7) };
    wire.invoke.mockResolvedValue({ ok: true, value: choice });
    expect(await prepareAcpWindowHistory('conversation', 'opening')).toEqual(choice);
    expect(wire.invoke.mock.calls).toEqual([['sessionTimeline.sessionWindowPrepare', { conversationId: 'conversation', subscriptionId: 'opening' }]]);
  });

  it('does not turn failed preparation into a legacy choice', async () => {
    wire.invoke.mockResolvedValue({ ok: false, error: fail });
    await expect(prepareAcpWindowHistory('conversation', 'opening')).rejects.toMatchObject(fail);
    expect(wire.invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects a window preparation without its original cursor rather than synthesizing a first Read', async () => {
    wire.invoke.mockResolvedValue({ ok: true, value: { source: 'window' } });
    await expect(prepareAcpWindowHistory('conversation', 'opening')).rejects.toThrow();
    expect(wire.invoke).toHaveBeenCalledTimes(1);
  });

  it('uses the original Prepare cursor and actual Read/ACK proxy paths, then reads the last B even with hasMore=false', async () => {
    const body = Promise.withResolvers<string>(), waiting = Promise.withResolvers<unknown>();
    const materialize = vi.fn().mockReturnValueOnce(body.promise).mockResolvedValueOnce('B');
    const commit = vi.fn(), failed = vi.fn(); let reads = 0, current = true;
    wire.invoke.mockImplementation(async channel => {
      if (channel === 'sessionTimeline.sessionWindowPrepare') return { ok: true, value: { source: 'window', liveCursor: at(7) } };
      if (channel === 'sessionTimeline.sessionWindowLiveRead') return ++reads <= 2 ? { ok: true, value: livePage(7 + reads) } : waiting.promise;
      return { ok: true, value: undefined };
    });
    const choice = await prepareAcpWindowHistory('conversation', 'opening');
    if (choice.source !== 'window') throw new Error('Expected the window path');
    const reader = startAcpWindowCommitIpc({ conversationId: 'conversation', subscriptionId: 'opening', after: choice.liveCursor }, {
      isCurrent: () => current, materialize, commit, failed,
    }); cleanups.push(reader.close);
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledTimes(1));
    expect(wire.invoke.mock.calls.some(([name]) => name.endsWith('LiveAck'))).toBe(false);
    body.resolve('A');
    await vi.waitFor(() => expect(reads).toBe(3));
    expect(commit.mock.calls.map(([resident]) => resident)).toEqual(['A', 'B']);
    expect(wire.invoke.mock.calls.slice(1)).toEqual([
      ['sessionTimeline.sessionWindowLiveRead', { conversationId: 'conversation', subscriptionId: 'opening', after: at(7) }],
      ['sessionTimeline.sessionWindowLiveAck', { conversationId: 'conversation', subscriptionId: 'opening', through: at(8) }],
      ['sessionTimeline.sessionWindowLiveRead', { conversationId: 'conversation', subscriptionId: 'opening', after: at(8) }],
      ['sessionTimeline.sessionWindowLiveAck', { conversationId: 'conversation', subscriptionId: 'opening', through: at(9) }],
      ['sessionTimeline.sessionWindowLiveRead', { conversationId: 'conversation', subscriptionId: 'opening', after: at(9) }],
    ]);
    current = false; reader.close(); waiting.resolve({ ok: true, value: livePage(10) }); await reader.completed;
    expect(commit).toHaveBeenCalledTimes(2); expect(failed).not.toHaveBeenCalled();
    expect(wire.invoke).toHaveBeenLastCalledWith('sessionTimeline.sessionUnsubscribe', { subscriptionId: 'opening' });
  });

  it('keeps structured Read failure terminal and releases only that prepared owner', async () => {
    const materialize = vi.fn(), commit = vi.fn(), failed = vi.fn();
    wire.invoke.mockImplementation(async channel => channel.endsWith('LiveRead') ? { ok: false, error: fail } : undefined);
    const reader = startAcpWindowCommitIpc({ conversationId: 'conversation', subscriptionId: 'old-opening', after: at(7) }, {
      isCurrent: () => true, materialize, commit, failed,
    }); await reader.completed;
    expect(materialize).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(fail));
    expect(wire.invoke.mock.calls.map(([channel]) => channel)).toEqual(['sessionTimeline.sessionWindowLiveRead', 'sessionTimeline.sessionUnsubscribe']);
    expect(wire.invoke).toHaveBeenLastCalledWith('sessionTimeline.sessionUnsubscribe', { subscriptionId: 'old-opening' });
  });

  it.each(['replaced', 'closed'] as const)('does not publish materialized content after its owner is %s', async reason => {
    const body = Promise.withResolvers<string>(), materialize = vi.fn(() => body.promise);
    const resident = ['already painted body'], commit = vi.fn((value: string) => { resident.push(value); }), failed = vi.fn();
    let current = true;
    wire.invoke.mockImplementation(async channel => channel.endsWith('LiveRead') ? { ok: true, value: livePage(8) } : undefined);
    const reader = startAcpWindowCommitIpc({ conversationId: 'conversation', subscriptionId: 'old-opening', after: at(7) }, {
      isCurrent: () => current, materialize, commit, failed,
    }); cleanups.push(reader.close);
    await vi.waitFor(() => expect(materialize).toHaveBeenCalledOnce());
    if (reason === 'replaced') current = false;
    else reader.close();
    body.resolve('late old body'); await reader.completed;
    expect(resident).toEqual(['already painted body']); expect(commit).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(wire.invoke.mock.calls).toEqual([
      ['sessionTimeline.sessionWindowLiveRead', { conversationId: 'conversation', subscriptionId: 'old-opening', after: at(7) }],
      ['sessionTimeline.sessionUnsubscribe', { subscriptionId: 'old-opening' }],
    ]);
  });

  it('discards a late failure after the store generation changed without reporting it to the new opening', async () => {
    const waiting = Promise.withResolvers<unknown>(), failed = vi.fn(); let current = true;
    wire.invoke.mockImplementation(channel => channel.endsWith('LiveRead') ? waiting.promise : Promise.resolve(undefined));
    const reader = startAcpWindowCommitIpc({ conversationId: 'conversation', subscriptionId: 'old-opening', after: at(7) }, {
      isCurrent: () => current, materialize: vi.fn(), commit: vi.fn(), failed,
    }); current = false; waiting.resolve({ ok: false, error: fail }); await reader.completed;
    expect(failed).not.toHaveBeenCalled();
    expect(wire.invoke).toHaveBeenLastCalledWith('sessionTimeline.sessionUnsubscribe', { subscriptionId: 'old-opening' });
  });

  it('releases the captured subscription even if the caller mutates its opening input', async () => {
    const waiting = Promise.withResolvers<unknown>(), failed = vi.fn();
    wire.invoke.mockImplementation(channel => channel.endsWith('LiveRead') ? waiting.promise : Promise.resolve(undefined));
    const input = { conversationId: 'conversation', subscriptionId: 'old-opening', after: at(7) };
    const reader = startAcpWindowCommitIpc(input, { isCurrent: () => true, materialize: vi.fn(), commit: vi.fn(), failed });
    input.subscriptionId = 'new-opening'; reader.close(); waiting.resolve({ ok: true, value: livePage(8) }); await reader.completed;
    expect(wire.invoke).toHaveBeenLastCalledWith('sessionTimeline.sessionUnsubscribe', { subscriptionId: 'old-opening' });
    expect(failed).not.toHaveBeenCalled();
  });

  it('retains committed resident content when the real ACK path returns a typed failure', async () => {
    const failed = vi.fn();
    wire.invoke.mockImplementation(async channel => channel.endsWith('LiveRead') ? { ok: true, value: livePage(8) }
      : channel.endsWith('LiveAck') ? { ok: false, error: fail } : undefined);
    const port = { resident: [] as string[], isCurrent: () => true,
      async materialize() { expect(this.resident).toEqual([]); return 'bounded new body'; },
      commit(value: string) { this.resident.push(value); }, failed };
    const reader = startAcpWindowCommitIpc({ conversationId: 'conversation', subscriptionId: 'opening', after: at(7) }, port);
    await reader.completed;
    expect(port.resident).toEqual(['bounded new body']); expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(fail));
    expect(wire.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'sessionTimeline.sessionWindowLiveRead', 'sessionTimeline.sessionWindowLiveAck', 'sessionTimeline.sessionUnsubscribe',
    ]);
  });

  it('decodes a structured setup failure into failed instead of leaving the screen loading', async () => {
    const { history, changed } = fixture();
    wire.invoke.mockImplementation(async channel => channel === 'sessionTimeline.sessionWindowSubscribe'
      ? { ok: false, error: fail } : undefined);
    await history.open();
    expect(history.view).toMatchObject({ phase: 'failed', error: fail });
    expect(changed.mock.calls.filter(([view]) => view.phase === 'failed')).toHaveLength(1);
    expect(wire.invoke.mock.calls.filter(([channel]) => channel.endsWith('sessionWindowSubscribe'))).toHaveLength(1);
    expect(wire.listeners.size).toBe(0);
  });

  it('subscribes once over the local window route after registering both real event topics', async () => {
    const { history } = fixture();
    wire.invoke.mockImplementation(async (channel, input) => {
      if (channel === 'sessionTimeline.sessionWindowSubscribe') {
        expect(input).toEqual({ conversationId: 'conversation', subscriptionId: 'subscription', cursor: null, trim: false });
        expect([...wire.listeners.keys()]).toEqual(['session-timeline:push.subscription', 'session-window:status.subscription']);
        emitBody();
        return { ok: true, value: null };
      }
    });
    await history.open();
    expect(history.view).toMatchObject({ phase: 'ready', timeline: { sourceFragments: [{ text: 'Historical body' }] } });
    expect(wire.invoke.mock.calls.map(([channel]) => channel)).toEqual(['sessionTimeline.sessionWindowSubscribe']);
    history.close();
    await Promise.resolve();
    expect(wire.invoke).toHaveBeenLastCalledWith('sessionTimeline.sessionUnsubscribe', { subscriptionId: 'subscription' });
    expect(wire.listeners.size).toBe(0);
  });

  it('keeps a pre-ACK typed failure terminal despite a later successful wire ACK', async () => {
    const { history } = fixture();
    wire.invoke.mockImplementation(async channel => {
      if (channel !== 'sessionTimeline.sessionWindowSubscribe') return;
      emitBody();
      const status: SessionpageSessionWindowStatusEvent = {
        conversationId: 'conversation', subscriptionId: 'subscription', state: 'failed', error: fail,
      };
      wire.listeners.get('session-window:status.subscription')!(status);
      return { ok: true, value: null };
    });
    await history.open();
    expect(history.view).toMatchObject({ phase: 'failed', error: fail, timeline: { sourceFragments: [{ text: 'Historical body' }] } });
    expect(wire.listeners.size).toBe(0);
    expect(wire.invoke.mock.calls.filter(([channel]) => channel === 'sessionTimeline.sessionWindowSubscribe')).toHaveLength(1);
  });
});
