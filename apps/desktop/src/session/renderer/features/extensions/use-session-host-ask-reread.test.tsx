// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settlement, TimelineAfterResult } from '@gugu/session-core/session-record/contract';
import { useSessionHostAsk } from './use-session-host-ask';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(), warn: vi.fn(),
  listeners: new Map<string, (event: { result: unknown }) => void>(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (_channel: unknown, listener: (event: { result: unknown }) => void, topic: string) => {
    mocks.listeners.set(topic, listener);
    return () => mocks.listeners.delete(topic);
  } },
  rpc: {},
  rpcOn: () => ({ sessionTimeline: { sessionSnapshot: mocks.snapshot, sessionSubscribe: mocks.subscribe, sessionUnsubscribe: mocks.unsubscribe } }),
}));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: mocks.warn } }));

const SOURCES = ['agent-question'] as const;
const question: Settlement = {
  itemId: 'agent-question:1', kind: 'question', title: 'Which colour?', state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null,
  options: [{ optionId: 'Red', name: 'Red' }, { optionId: 'Blue', name: 'Blue' }],
  questions: [{ question: 'Which colour?', multiSelect: false, options: [{ optionId: 'Red', name: 'Red' }, { optionId: 'Blue', name: 'Blue' }] }],
  origin: { source: 'agent-question', payload: {} },
};
const push = (result: TimelineAfterResult) => {
  const [topic] = [...mocks.listeners.keys()];
  mocks.listeners.get(topic!)!({ result });
};
const batch = (from: number, cursor: { epoch: string; seq: number }, settlements: Settlement[] = []): TimelineAfterResult =>
  ({ ok: true, batch: { from, cursor, turns: [], removedTurnIds: [], settlements } });
const answered: Settlement = { ...question, state: 'resolved', optionId: 'Red', resolvedBy: 'desktop', resolvedAt: 1 };
/** A reply the test hands back by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;
let ask: Settlement | null;
function Probe() {
  ask = useSessionHostAsk('session-1', SOURCES, true);
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.subscribe.mockResolvedValue({ ok: true });
  mocks.unsubscribe.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('a session question asked after its timeline was replaced', () => {
  it('reads the session again when a batch comes from another epoch', async () => {
    // A new session opens on its stand-in; its real record replaces it, and the question is asked on the real one.
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'stand-in:session-1', seq: 0 } } });
    await act(async () => root.render(<Probe />));
    expect(ask).toBeNull();

    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [question], cursor: { epoch: 'real', seq: 4 } } });
    await act(async () => push({ ok: true, batch: { from: 0, cursor: { epoch: 'stand-in:session-1:replaced', seq: 0 }, turns: [], removedTurnIds: [], settlements: [] } }));

    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(mocks.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { epoch: 'real', seq: 4 } }));
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mocks.listeners.size).toBe(1);
    expect(ask?.itemId).toBe('agent-question:1');
  });

  it('takes a batch that continues what it holds', async () => {
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'real', seq: 4 } } });
    await act(async () => root.render(<Probe />));
    await act(async () => push({ ok: true, batch: { from: 4, cursor: { epoch: 'real', seq: 5 }, turns: [], removedTurnIds: [], settlements: [question] } }));
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(ask?.itemId).toBe('agent-question:1');
  });

  it('does not take a batch that skips seqs: it reads again', async () => {
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'real', seq: 4 } } });
    await act(async () => root.render(<Probe />));
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'real', seq: 9 } } });
    await act(async () => push(batch(8, { epoch: 'real', seq: 9 }, [question])));
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(ask).toBeNull();
  });

  it('a replayed older batch does not reopen an answered question; a newer one may', async () => {
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [answered], cursor: { epoch: 'real', seq: 4 } } });
    await act(async () => root.render(<Probe />));
    await act(async () => push(batch(2, { epoch: 'real', seq: 3 }, [question])));
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(ask).toBeNull();
    // The host put it back (a claimed answer that failed to deliver): the batch that moves forward says so.
    await act(async () => push(batch(4, { epoch: 'real', seq: 5 }, [question])));
    expect(ask?.state).toBe('pending');
  });

  it('a generation replaced while it subscribes closes the subscription it opened late', async () => {
    const subscribing = deferred<unknown>();
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'e1', seq: 0 } } });
    mocks.subscribe.mockReturnValueOnce(subscribing.promise);
    await act(async () => root.render(<Probe />));
    // The timeline is replaced before the first subscription's reply is back.
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [question], cursor: { epoch: 'e2', seq: 2 } } });
    await act(async () => push(batch(0, { epoch: 'e2', seq: 0 })));
    await act(async () => subscribing.resolve({ ok: true }));
    const first = mocks.subscribe.mock.calls[0]![0].subscriptionId;
    expect(mocks.unsubscribe.mock.calls.filter(([input]) => input.subscriptionId === first)).toHaveLength(2);
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(mocks.listeners.size).toBe(1);
    expect(ask?.itemId).toBe('agent-question:1');
  });

  it('a subscription that lands after the page left is closed again', async () => {
    const subscribing = deferred<unknown>();
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'real', seq: 4 } } });
    mocks.subscribe.mockReturnValueOnce(subscribing.promise);
    await act(async () => root.render(<Probe />));
    act(() => root.unmount());
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    await act(async () => subscribing.resolve({ ok: true }));
    const [subscribed] = mocks.subscribe.mock.calls[0]!;
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(2);
    expect(mocks.unsubscribe).toHaveBeenLastCalledWith({ subscriptionId: subscribed.subscriptionId });
    root = createRoot(container);
  });

  it('a refused subscription is reported', async () => {
    mocks.snapshot.mockResolvedValueOnce({ ok: true, value: { settlements: [], cursor: { epoch: 'real', seq: 4 } } });
    mocks.subscribe.mockResolvedValueOnce({ ok: false, error: { code: 'invalid_subscription', message: 'nope' } });
    await act(async () => root.render(<Probe />));
    expect(mocks.warn).toHaveBeenCalledWith('Host asks of this session could not be read', expect.objectContaining({ error: 'sessionSubscribe refused: invalid_subscription: nope' }));
  });
});
