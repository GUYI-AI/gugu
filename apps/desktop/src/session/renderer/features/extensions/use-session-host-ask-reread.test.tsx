// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settlement, TimelineAfterResult } from '@gugu/session-core/session-record/contract';
import { useSessionHostAsk } from './use-session-host-ask';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
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
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));

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
});
