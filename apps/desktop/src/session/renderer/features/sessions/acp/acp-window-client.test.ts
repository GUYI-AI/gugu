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
import { acpWindowHistoryClient, prepareAcpWindowHistory } from './acp-window-client';

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

describe('ACP window IPC binding', () => {
  it.each(['window', 'legacy'] as const)('prepares the %s source without invoking a history reader', async source => {
    wire.invoke.mockResolvedValue({ ok: true, value: { source } });
    expect(await prepareAcpWindowHistory('conversation', 'opening')).toBe(source);
    expect(wire.invoke.mock.calls).toEqual([['sessionTimeline.sessionWindowPrepare', { conversationId: 'conversation', subscriptionId: 'opening' }]]);
  });

  it('does not turn failed preparation into a legacy choice', async () => {
    wire.invoke.mockResolvedValue({ ok: false, error: fail });
    await expect(prepareAcpWindowHistory('conversation', 'opening')).rejects.toMatchObject(fail);
    expect(wire.invoke).toHaveBeenCalledTimes(1);
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
