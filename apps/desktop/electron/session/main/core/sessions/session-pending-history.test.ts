import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeInputEvidence } from '@gugu/core/local/agent/deliveryIdentity';

const mocks = vi.hoisted(() => ({
  row: { provider: 'codex', providerSessionId: 'native-session', runtime: 'acp' } as { provider: string; providerSessionId: string; runtime?: string } | null,
  read: vi.fn(),
  locate: vi.fn(),
  current: vi.fn(),
}));
vi.mock('../session-timeline/service', () => ({ readSessionRow: () => mocks.row, locateRow: mocks.locate }));
vi.mock('../acp/agent-status-bridge', () => ({ acpAgentStatusBridge: { current: mocks.current } }));
vi.mock('@gugu/session-core/session-record', () => ({ readNativeInputTail: mocks.read }));
import { nativePendingInputLookup } from './session-pending-history';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.row = { provider: 'codex', providerSessionId: 'native-session', runtime: 'acp' };
  mocks.locate.mockReturnValue({ supported: true, locator: { harness: 'codex', providerSessionId: 'native-session', roots: ['/native'] } });
  mocks.current.mockReturnValue(new Map());
  mocks.read.mockResolvedValue({ find: () => ({ state: 'received', nativeReceiptId: 'native-user' }) });
});

it('uses one bounded native tail for concurrent pending inputs, without consulting stored turns or starting a provider', async () => {
  const lookup = nativePendingInputLookup('s');
  const inputs = [{ id: 'first', text: 'delivery one' }, { id: 'second', text: 'delivery two' }];
  expect(await Promise.all(inputs.map(lookup))).toEqual(inputs.map(() => ({ state: 'received', nativeReceiptId: 'native-user' })));
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.read).toHaveBeenCalledWith({ harness: 'codex', providerSessionId: 'native-session', roots: ['/native'] }, { path: undefined });
});

it('keeps native-source absence/incomplete evidence distinct instead of turning either into a successful empty lookup', async () => {
  for (const evidence of [{ state: 'absent', reason: 'native_input_absent' }, { state: 'incomplete', reason: 'native_source_unreadable' }] satisfies NativeInputEvidence[]) {
    mocks.read.mockResolvedValueOnce({ find: () => evidence });
    expect(await nativePendingInputLookup('s')({ id: 'id', text: 'delivery' })).toEqual(evidence);
  }
});

it('uses the live harness-reported path and refuses a native session changed during the read', async () => {
  mocks.current.mockReturnValue(new Map([['s', { providerId: 'codex', transcriptPath: '/native/reported.jsonl' }]]));
  mocks.read.mockImplementationOnce(async () => {
    mocks.row = { provider: 'codex', providerSessionId: 'replacement' };
    return { find: () => ({ state: 'received', nativeReceiptId: 'stale' }) };
  });
  expect(await nativePendingInputLookup('s')({ id: 'id', text: 'delivery' })).toEqual({ state: 'incomplete', reason: 'native_session_changed' });
  expect(mocks.read.mock.calls[0]?.[1]).toEqual({ path: '/native/reported.jsonl' });
});

it('reports unsupported and missing locations without reading another session', async () => {
  mocks.row = null;
  expect(await nativePendingInputLookup('missing')({ id: 'id', text: 'delivery' })).toEqual({ state: 'incomplete', reason: 'native_session_unavailable' });
  mocks.row = { provider: 'custom', providerSessionId: 'native' };
  mocks.locate.mockReturnValue({ supported: false, reason: 'not supported' });
  expect(await nativePendingInputLookup('s')({ id: 'id', text: 'delivery' })).toEqual({ state: 'incomplete', reason: 'native_location_unavailable' });
  expect(mocks.read).not.toHaveBeenCalled();
});
it.each(['providerSessionId', 'provider', 'runtime', 'missing'] as const)('rejects a shared tail after its %s binding changes', async field => {
  const lookup = nativePendingInputLookup('s');
  expect(await lookup({ id: 'first', text: 'delivery' })).toEqual({ state: 'received', nativeReceiptId: 'native-user' });
  expect(lookup.isCurrent?.()).toBe(true);
  if (field === 'missing') mocks.row = null;
  else mocks.row![field] = 'replacement';
  expect(lookup.isCurrent?.()).toBe(false);
  expect(await lookup({ id: 'second', text: 'delivery' })).toEqual({ state: 'incomplete', reason: 'native_session_changed' });
  expect(mocks.read).toHaveBeenCalledTimes(1);
});
