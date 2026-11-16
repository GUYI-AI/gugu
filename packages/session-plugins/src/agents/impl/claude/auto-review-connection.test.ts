import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpClient, AcpProcessIo } from '@gugu/session-core/agents/plugins';
import { connectClaudeWithReview } from './auto-review-connection';

const mock = vi.hoisted(() => ({ client: null as AcpClient | null, current: [] as SessionConfigOption[],
  set: vi.fn(), mode: vi.fn(), publish: vi.fn(), api: {} as Record<string, unknown> }));
vi.mock('../../helpers/acp-v2', () => ({ connectStdioAcpV2: (_io: unknown, factory: (api: unknown) => AcpClient) => {
  mock.api = {
    newSession: async () => ({ sessionId: 'session', configOptions: mock.current }),
    loadSession: async () => ({ configOptions: mock.current }),
    setSessionConfigOption: mock.set,
    setSessionMode: mock.mode,
  };
  mock.client = factory(mock.api);
  return mock.api;
} }));
const configs = (model: string): SessionConfigOption[] => [
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: [{ value: model, name: model }] },
  { id: 'mode', name: 'Mode', type: 'select', category: 'mode', currentValue: 'acceptEdits', options: ['acceptEdits', 'auto'].map(value => ({ value, name: value })) },
];
const connect = (version?: string) => connectClaudeWithReview({} as AcpProcessIo,
  () => ({ sessionEvent: mock.publish }) as unknown as AcpClient, version);
const start = { cwd: '/fixture', mcpServers: [] };
beforeEach(() => {
  mock.current = configs('claude-opus-5');
  mock.set.mockReset().mockImplementation(async () => ({ configOptions: mock.current }));
  mock.mode.mockReset().mockResolvedValue({});
  mock.publish.mockClear();
});
it.each([undefined, '2.1.293'])('filters the session and reconnect on actual host CLI %s', async version => {
  const api = connect(version);
  const fresh = await api.newSession(start);
  expect(fresh.configOptions?.find(option => option.id === 'mode')).toMatchObject({ options: [{ value: 'acceptEdits', name: 'acceptEdits' }] });
  const resumed = await api.loadSession!({ ...start, sessionId: 'session' });
  expect(resumed.configOptions).toEqual(fresh.configOptions);
  await expect(api.setSessionConfigOption!({ sessionId: 'session', configId: 'mode', value: 'auto' })).rejects.toThrow('unavailable');
  expect(mock.set).not.toHaveBeenCalled();
});
it('routes an admitted auto intent to the same native mode channel and preserves manual switching', async () => {
  const api = connect('2.1.302');
  await api.newSession(start);
  await api.setSessionConfigOption!({ sessionId: 'session', configId: 'mode', value: 'auto' });
  expect(mock.set).toHaveBeenLastCalledWith({ sessionId: 'session', configId: 'mode', value: 'auto' });
  await api.setSessionConfigOption!({ sessionId: 'session', configId: 'mode', value: 'acceptEdits' });
  expect(mock.set).toHaveBeenLastCalledWith({ sessionId: 'session', configId: 'mode', value: 'acceptEdits' });
});
it('removes auto when a live model update loses support, rejecting a forged selection', async () => {
  const api = connect('2.1.311');
  await api.newSession(start);
  mock.client!.sessionEvent({ sessionId: 'session', event: { kind: 'config', options: configs('deepseek-v4') } });
  expect(mock.publish.mock.calls.at(-1)?.[0].event.options[1].options).toHaveLength(1);
  await expect(api.setSessionMode!({ sessionId: 'session', modeId: 'auto' })).rejects.toThrow('unavailable');
  expect(mock.mode).not.toHaveBeenCalled();
});
it('shows a native denial once with its action and reason, without sending an approval', () => {
  connect('2.1.311');
  const frame = { sessionId: 'session', event: { kind: 'tool_update' as const, toolCallId: 'call', status: 'failed' as const },
    trace: { _meta: { claudeCode: { toolName: 'Bash', toolResponse: { decisionReason: 'Deletes an unrelated directory' } } } } };
  mock.client!.sessionEvent(frame);
  mock.client!.sessionEvent(frame);
  const notices = mock.publish.mock.calls.map(call => call[0].event).filter(event => event.kind === 'session_notice');
  expect(notices).toEqual([{ kind: 'session_notice', code: 'provider-notice', title: 'Bash: Deletes an unrelated directory', detail: 'Bash: Deletes an unrelated directory' }]);
  expect(mock.set).not.toHaveBeenCalled();
});
