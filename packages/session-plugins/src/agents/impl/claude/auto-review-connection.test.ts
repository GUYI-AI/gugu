import { beforeEach, expect, it, vi } from 'vitest';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import type { AcpClient, AcpProcessIo } from '@gugu/session-core/agents/plugins';
import { flattenSelectOptions } from '@gugu/session-core/acp';
import { connectClaudeWithReview } from './auto-review-connection';
import { createClaudeSessionDecoder } from './acp-transform';

const mock = vi.hoisted(() => ({ client: null as AcpClient | null, current: [] as SessionConfigOption[],
  set: vi.fn(), mode: vi.fn(), publish: vi.fn(), permission: vi.fn(), api: {} as Record<string, unknown> }));
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
  () => ({ sessionEvent: mock.publish, requestPermission: mock.permission }) as unknown as AcpClient, version);
const start = { cwd: '/fixture', mcpServers: [] };
beforeEach(() => {
  mock.current = configs('claude-opus-5');
  mock.set.mockReset().mockImplementation(async () => ({ configOptions: mock.current }));
  mock.mode.mockReset().mockResolvedValue({});
  mock.publish.mockClear();
  mock.permission.mockReset();
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
it.each([
  ['sonnet', 'Claude Sonnet 4.6'], ['sonnet[1m]', 'Claude Sonnet 4.6'],
  ['haiku', 'Claude Haiku 5.5'], ['default', 'Claude Opus 5'],
])('forwards a native-qualified %s model alias while auto remains selected', async (target, description) => {
  mock.current = configs('claude-opus-5').map(option => option.id === 'model' && option.type === 'select'
    ? { ...option, options: [...flattenSelectOptions(option.options), { value: target, name: target, description }] }
    : option.id === 'mode' && option.type === 'select' ? { ...option, currentValue: 'auto' } : option);
  const api = connect('2.1.322');
  await api.newSession(start);
  mock.set.mockImplementation(async params => ({ configOptions: mock.current.map(option => option.id === 'model' && option.type === 'select'
    ? { ...option, currentValue: params.value } : option) }));
  const request = { sessionId: 'session', configId: 'model', value: target };
  const result = await api.setSessionConfigOption!(request);
  expect(mock.set).toHaveBeenCalledExactlyOnceWith(request);
  expect(result.configOptions?.find(option => option.id === 'model')).toMatchObject({ currentValue: target });
  expect(result.configOptions?.find(option => option.id === 'mode')).toMatchObject({ currentValue: 'auto' });
  expect(mock.mode).not.toHaveBeenCalled();
});
it.each([
  ['2.1.322', 'sonnet', 'Claude Sonnet 4.5'], ['2.1.322', 'sonnet', ''], ['2.1.322', 'default', 'DeepSeek V4'],
  ['2.1.322', 'undeclared-alias', 'Claude Sonnet 4.6'], ['2.1.301', 'sonnet', 'Claude Sonnet 4.6'],
])('rejects an unqualified target without changing native auto (%s / %s / %s)', async (version, target, description) => {
  mock.current = configs('claude-opus-5').map(option => option.id === 'model' && option.type === 'select'
    ? { ...option, options: [...flattenSelectOptions(option.options), { value: target, name: target, description }] }
    : option.id === 'mode' && option.type === 'select' ? { ...option, currentValue: 'auto' } : option);
  const original = mock.current;
  const api = connect(version);
  await api.newSession(start);
  await expect(api.setSessionConfigOption!({ sessionId: 'session', configId: 'model', value: target })).rejects.toThrow('Change permissions');
  expect(mock.set).not.toHaveBeenCalled();
  expect(mock.mode).not.toHaveBeenCalled();
  expect(mock.current).toBe(original);
  expect(mock.current.find(option => option.id === 'mode')).toMatchObject({ currentValue: 'auto' });
});
// Shape emitted by the @gugu-acp/claude-agent-acp 1.6.2 v2 renderer.
// These are protocol fixtures, not evidence of a paid Claude request.
const nativeDenial = (reason?: string) => ({ sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'failed',
  content: [{ type: 'content', content: { type: 'text', text: `Permission denied: ${reason ?? 'Action blocked by policy'}` } }],
  _meta: { claudeCode: { toolName: 'Bash', toolResponse: { decisionReasonType: 'auto_mode', ...(reason ? { message: 'Action blocked by policy' } : {}) } } },
});
it.each([undefined, 'Deletes an unrelated directory'])('shows a native denial once per session, with v2 content fallback (%s)', reason => {
  connect('2.1.322');
  const raw = nativeDenial(reason);
  expect(raw._meta.claudeCode.toolResponse).not.toHaveProperty('decisionReason');
  const event = createClaudeSessionDecoder()(raw);
  const frame = { sessionId: 'session', event };
  mock.client!.sessionEvent(frame);
  mock.client!.sessionEvent(frame);
  mock.client!.sessionEvent({ ...frame, sessionId: 'other-session' });
  const notices = mock.publish.mock.calls.map(call => call[0]).filter(call => call.event.kind === 'session_notice');
  const line = `Bash: ${reason ?? 'Action blocked by policy'}`;
  expect(notices).toEqual(['session', 'other-session'].map(sessionId => ({ sessionId,
    event: { kind: 'session_notice', code: 'provider-notice', title: line, detail: line } })));
  expect(mock.set).not.toHaveBeenCalled();
  expect(mock.permission).not.toHaveBeenCalled();
  expect(mock.publish.mock.calls.at(-1)?.[0].event).toBe(event);
});
it('retains the legacy metadata-only denial as a compatibility counterexample, not a v2 fixture', () => {
  connect('2.1.322');
  const event = createClaudeSessionDecoder()({ sessionUpdate: 'tool_call_update', toolCallId: 'legacy-call', status: 'failed',
    _meta: { claudeCode: { toolName: 'Bash', toolResponse: { decisionReason: 'Legacy denial reason' } } },
  });
  mock.client!.sessionEvent({ sessionId: 'session', event });
  expect(mock.publish.mock.calls.map(call => call[0].event)).toEqual([
    { kind: 'session_notice', code: 'provider-notice', title: 'Bash: Legacy denial reason', detail: 'Bash: Legacy denial reason' },
    event,
  ]);
  expect(mock.set).not.toHaveBeenCalled();
  expect(mock.permission).not.toHaveBeenCalled();
});
it('keeps successful tool completion and ordinary errors intact without a denial notice', () => {
  connect('2.1.322');
  const decode = createClaudeSessionDecoder();
  for (const raw of [
    { ...nativeDenial('Allowed'), status: 'completed' },
    { sessionUpdate: 'tool_call_update', toolCallId: 'error', status: 'failed',
      _meta: { claudeCode: { toolResponse: { message: 'Network error' } } } },
  ]) mock.client!.sessionEvent({ sessionId: 'session', event: decode(raw) });
  expect(mock.publish.mock.calls).toHaveLength(2);
  expect(mock.publish.mock.calls.map(call => call[0].event.kind)).toEqual(['tool_update', 'tool_update']);
});
it.each(['allow', 'deny', 'cancelled'])('preserves the native permission callback outcome %s', async outcome => {
  connect('2.1.322');
  const response = outcome === 'cancelled' ? { outcome: { outcome: 'cancelled' as const } }
    : { outcome: { outcome: 'selected' as const, optionId: outcome } };
  mock.permission.mockResolvedValue(response);
  const request = { sessionId: 'session', title: 'Run command?', options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' as const },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' as const },
  ] };
  expect(await mock.client!.requestPermission(request)).toBe(response);
  expect(mock.permission).toHaveBeenCalledExactlyOnceWith(request);
  expect(mock.set).not.toHaveBeenCalled();
});

it('rejects forged Auto when the host has no explicit custom main model, even if the native default qualifies', async () => {
  const api = connectClaudeWithReview({} as AcpProcessIo,
    () => ({ sessionEvent: mock.publish, requestPermission: mock.permission }) as unknown as AcpClient, '2.1.310', false);
  await api.newSession(start);
  await expect(api.setSessionMode!({ sessionId: 'session', modeId: 'auto' })).rejects.toThrow('unavailable');
  expect(mock.mode).not.toHaveBeenCalled();
  await expect(api.setSessionConfigOption!({ sessionId: 'session', configId: 'mode', value: 'auto' })).rejects.toThrow('unavailable');
  expect(mock.set).not.toHaveBeenCalled();
});

it('advertises an unavailable reviewer as disabled while rejecting both native setting channels', async () => {
  const api = connectClaudeWithReview({} as AcpProcessIo,
    () => ({ sessionEvent: mock.publish, requestPermission: mock.permission }) as unknown as AcpClient, '2.1.310', false, true);
  const result = await api.newSession(start);
  const mode = result.configOptions!.find(option => option.category === 'mode')!;
  expect(mode.type === 'select' && flattenSelectOptions(mode.options).find(option => option.value === 'auto')?._meta)
    .toMatchObject({ 'gugu:auto-review-disabled': true });
  await expect(api.setSessionMode!({ sessionId: 'session', modeId: 'auto' })).rejects.toThrow('unavailable');
  await expect(api.setSessionConfigOption!({ sessionId: 'session', configId: 'mode', value: 'auto' })).rejects.toThrow('unavailable');
  expect(mock.mode).not.toHaveBeenCalled();
  expect(mock.set).not.toHaveBeenCalled();
});
