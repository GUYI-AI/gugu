import { describe, expect, it, vi } from 'vitest';
import type { SessionPromptReceipt } from '@gugu/session-core/acp';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';
import type { ChatMessage } from '@session-chat/model';
import { conversationBubbleKey } from '../../../../session-chat-ui/src/components/rows/message/conversation-body';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from '../runtime/runtime';

const users = (history: ReturnType<SessionCell['history']>) => [...history.committed, ...(history.active ? [history.active] : [])]
  .flatMap(turn => turn.items.filter((item): item is Extract<typeof item, { kind: 'message' }> => item.kind === 'message' && item.role === 'user'));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const receipts: ReturnType<typeof Promise.withResolvers<SessionPromptReceipt>>[] = [];
  const prompt = vi.fn(() => { const receipt = Promise.withResolvers<SessionPromptReceipt>(); receipts.push(receipt); return receipt.promise; });
  const closeSession = vi.fn(async () => {});
  const snapshots: ReturnType<SessionCell['history']>[] = [];
  const cell = new SessionCell({ sessionId: 'identity', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
    agent: { prompt, closeSession, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger,
    callbacks: { onTranscriptChanged: () => snapshots.push(cell.history()) } });
  cell.applySessionReady();
  const echo = (id: string) => cell.push({ kind: 'message', role: 'user', messageId: id, text: 'identical body' });
  const idle = () => cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
  return { cell, prompt, closeSession, receipts, snapshots, echo, idle };
}

describe('one submitted user identity through native admission', () => {
  it.each(['echo-before-running', 'running-before-echo'] as const)('%s never publishes a second entity or changes its identity', async order => {
    const receipt = Promise.withResolvers<SessionPromptReceipt>();
    const prompt = vi.fn(() => receipt.promise);
    const snapshots: ReturnType<SessionCell['history']>[] = [];
    const cell = new SessionCell({ sessionId: 'identity', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
      agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
      resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger,
      callbacks: { onTranscriptChanged: () => snapshots.push(cell.history()) } });
    cell.applySessionReady();
    const sent = cell.promptDetached({ text: 'hello', clientMessageId: 'client-owned' });
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    const original = users(cell.history())[0]!;
    if (order === 'running-before-echo') cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
    // No client/request identity is supplied by the native echo. Only the later receipt can correlate it.
    cell.push({ kind: 'message', role: 'user', messageId: 'provider-owned', text: 'hello' });
    if (order === 'echo-before-running') cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
    expect(snapshots.every(snapshot => users(snapshot).length === 1), 'every publication must keep one entity before receipt').toBe(true);
    receipt.resolve({ status: 'accepted', requestId: 'request', messageId: 'provider-owned' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(users(cell.history())).toMatchObject([{ id: original.id, _meta: { guguClientMessageId: 'client-owned', guguNativeMessageId: 'provider-owned' } }]);
    expect(snapshots.every(snapshot => users(snapshot).length === 1 && users(snapshot)[0]!.id === original.id)).toBe(true);
    cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
    expect(await sent.completion).toMatchObject({ success: true });
    cell.dispose();
  });

  it('keeps an unconfirmed echo private after provider failure and reuses the client identity on retry', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'retry-client' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.echo('unconfirmed-native');
      p.receipts[0]!.reject(Object.assign(new Error('receipt failed'), { code: 'provider_failure' }));
      expect(await first.completion).toMatchObject({ success: false });
      p.echo('unconfirmed-native');
      expect(users(p.cell.history())).toMatchObject([{ id: 'retry-client' }]);
      expect(users(p.cell.history())[0]!._meta).not.toHaveProperty('guguNativeMessageId');
      const retry = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'retry-client' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
      p.echo('retry-native');
      p.receipts[1]!.resolve({ status: 'accepted', requestId: 'retry', messageId: 'retry-native' });
      await flush();
      expect(users(p.cell.history())).toMatchObject([{ id: 'retry-client', _meta: { guguNativeMessageId: 'retry-native' } }]);
      expect(p.snapshots.every(snapshot => users(snapshot).length === 1)).toBe(true);
      p.idle();
      expect(await retry.completion).toMatchObject({ success: true });
      // The failed attempt must not keep buffering unrelated future native inputs after this retry.
      p.echo('unconfirmed-native');
      expect(users(p.cell.history())).toHaveLength(1);
      p.echo('future-native');
      expect(users(p.cell.history())).toHaveLength(2);
    } finally { p.cell.dispose(); }
  });

  it('correlates identical concurrent inputs only by receipt ID, even when receipts arrive in reverse order', async () => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'client-a' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      const second = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'client-b' }, { steerIfBusy: true });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
      p.echo('native-b'); p.echo('native-a');
      p.receipts[1]!.resolve({ status: 'accepted', requestId: 'b', messageId: 'native-b' });
      await flush();
      expect(users(p.cell.history())).toMatchObject([{ id: 'client-a' }, { id: 'client-b', _meta: { guguNativeMessageId: 'native-b' } }]);
      expect(users(p.cell.history())[0]!._meta).not.toHaveProperty('guguNativeMessageId');
      p.receipts[0]!.resolve({ status: 'accepted', requestId: 'a', messageId: 'native-a' });
      await flush();
      expect(users(p.cell.history())).toMatchObject([{ id: 'client-a', _meta: { guguNativeMessageId: 'native-a' } }, { id: 'client-b', _meta: { guguNativeMessageId: 'native-b' } }]);
      expect(p.snapshots.every(snapshot => users(snapshot).length <= 2)).toBe(true);
      p.idle(); await Promise.all([first.completion, second.completion]);
    } finally { p.cell.dispose(); }
  });

  it('leaves one original entity visible when a receipt never arrives and the executor closes', async () => {
    const p = fixture();
    const first = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'cancel-client' });
    await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
    p.echo('cancel-native');
    p.cell.processClosed({ exitCode: 1, signal: null, stderrTail: '' });
    expect(await first.completion).toMatchObject({ success: false });
    expect(users(p.cell.history())).toMatchObject([{ id: 'cancel-client' }]);
    expect(p.snapshots.every(snapshot => users(snapshot).length === 1)).toBe(true);
    p.cell.dispose();
  });

  it.each([
    { code: 'provider_failure', message: 'failed' },
    { code: 'CANCELLED', message: 'cancelled' },
    { code: -32002, message: 'Session not found', data: { sessionId: 's' } },
  ])('a rejected receipt ($code) does not hide later unrelated native inputs', async error => {
    const p = fixture();
    try {
      const a = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'client-a' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.echo('native-a'); p.receipts[0]!.reject(error);
      expect(await a.completion).toMatchObject({ success: false });
      const b = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'client-b' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(2));
      p.echo('native-b'); p.receipts[1]!.resolve({ status: 'accepted', requestId: 'b', messageId: 'native-b' });
      await flush(); p.idle(); await b.completion;
      const before = users(p.cell.history()).length;
      p.echo('native-a');
      expect(users(p.cell.history())).toHaveLength(before);
      p.echo('unrelated-c'); p.echo('unrelated-d');
      expect(users(p.cell.history())).toHaveLength(before + 2);
    } finally { p.cell.dispose(); }
  });

  it('keeps a cancellation-racing receipt bound to the same client entity until admission settles', async () => {
    const p = fixture();
    try {
      const sent = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'cancel-race' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
      expect(await p.cell.cancel()).toMatchObject({ success: true });
      p.echo('native-cancel-race');
      p.receipts[0]!.resolve({ status: 'accepted', requestId: 'cancel-race', messageId: 'native-cancel-race' });
      await flush();
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'cancelled' });
      await sent.completion;
      expect(p.snapshots.every(snapshot => users(snapshot).length === 1 && users(snapshot)[0]!.id === 'cancel-race')).toBe(true);
      p.echo('future-native');
      expect(users(p.cell.history())).toHaveLength(2);
    } finally { p.cell.dispose(); }
  });

  it('withholds the first late echo after the local watchdog wins while the native RPC and close still run', async () => {
    const p = fixture();
    const native = Promise.withResolvers<SessionPromptReceipt>();
    const watchdog = Promise.withResolvers<never>();
    const close = Promise.withResolvers<void>();
    p.prompt.mockImplementationOnce(() => Promise.race([native.promise, watchdog.promise]));
    p.closeSession.mockImplementationOnce(() => close.promise);
    try {
      const sent = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'timeout-client' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      const queued = p.cell.promptDetached({ text: 'waiting', origin: 'manual', clientMessageId: 'queued-client' });
      expect(await queued.admission).toMatchObject({ success: true, data: { queued: true } });
      watchdog.reject(Object.assign(new Error('Native prompt admission timed out'), { code: 'prompt_admission_timeout' }));
      expect(await sent.completion).toMatchObject({ success: false, error: { cause: { code: 'prompt_admission_timeout' } } });
      p.echo('late-native');
      p.cell.push({ kind: 'message', role: 'user', messageId: null, text: 'late unaddressed input' });
      expect(users(p.cell.history())).toMatchObject([{ id: 'timeout-client' }]);
      const next = p.cell.promptDetached({ text: 'next', clientMessageId: 'next-client' });
      expect(await next.admission).toMatchObject({ success: false, error: { type: 'session_busy' } });
      expect(p.prompt).toHaveBeenCalledTimes(1);
      expect(p.cell.sessionState.queuedPrompts).toMatchObject([{ clientMessageId: 'queued-client' }]);
      const closing = p.cell.closeSession();
      p.echo('late-native');
      native.resolve({ status: 'accepted', requestId: 'late', messageId: 'late-native' });
      await flush();
      expect(p.snapshots.every(snapshot => users(snapshot).length === 1)).toBe(true);
      expect(users(p.cell.history())[0]!._meta).not.toHaveProperty('guguNativeMessageId');
      close.resolve(); await closing;
      p.cell.processClosed({ exitCode: 0, signal: null, stderrTail: '' });
    } finally { close.resolve(); p.cell.dispose(); }
    const resumed = fixture();
    try {
      const retry = resumed.cell.promptDetached({ text: 'identical body', clientMessageId: 'timeout-client' });
      await vi.waitFor(() => expect(resumed.prompt).toHaveBeenCalledTimes(1));
      resumed.echo('retry-native');
      resumed.receipts[0]!.resolve({ status: 'accepted', requestId: 'retry', messageId: 'retry-native' });
      await flush(); resumed.idle(); await retry.completion;
      expect(users(resumed.cell.history())).toMatchObject([{ id: 'timeout-client', _meta: { guguNativeMessageId: 'retry-native' } }]);
      resumed.echo('unrelated-after-resume');
      expect(users(resumed.cell.history())).toHaveLength(2);
    } finally { resumed.cell.dispose(); }
  });
});

it.each(['prompt', 'promptDetached', 'queued'] as const)('retains native admission ownership through the %s runtime entry', async entry => {
  const h = makeAcpHarness({ nativeState: true });
  const runtime = new AcpRuntime(h.deps);
  const native = Promise.withResolvers<SessionPromptReceipt>();
  const close = Promise.withResolvers<object>();
  try {
    expect((await runtime.startSession(makeStartInput())).success).toBe(true);
    h.agent.closeSession.mockImplementationOnce(() => close.promise);
    vi.useFakeTimers();
    if (entry === 'queued') {
      h.agent.prompt.mockImplementationOnce(async () => {
        await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'message', role: 'user', messageId: 'first-native', text: 'first' } });
        return { status: 'accepted', requestId: 'first', messageId: 'first-native' };
      });
      const first = runtime.promptDetached('conv-1', { text: 'first', origin: 'manual', clientMessageId: 'first-client' });
      if (!first.success) throw new Error('First prompt did not start');
      await first.data.admission;
      await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'running' } });
    }
    h.agent.prompt.mockImplementationOnce(() => native.promise);
    const input = { text: 'identical body', origin: 'communication' as const, clientMessageId: 'timeout-client' };
    const admission = entry === 'prompt' ? runtime.sendPrompt('conv-1', input) : (() => {
      const sent = runtime.promptDetached('conv-1', input);
      if (!sent.success) throw new Error('Detached prompt did not start');
      return sent.data.admission;
    })();
    if (entry === 'queued') {
      expect(await admission).toMatchObject({ success: true, data: { queued: true } });
      await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' } });
    }
    await h.agent.called('prompt', entry === 'queued' ? 2 : 1);
    await vi.advanceTimersByTimeAsync(60_001);
    if (entry === 'queued') {
      // Already queued inputs have no new local admission deadline. Preserve that existing policy.
      expect(h.agent.closeSession).not.toHaveBeenCalled();
      await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'message', role: 'user', messageId: 'late-native', text: input.text } });
      native.resolve({ status: 'accepted', requestId: 'queued', messageId: 'late-native' });
      await vi.advanceTimersByTimeAsync(150);
      await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' } });
      const history = runtime.getHistory('conv-1');
      if (!history.success) throw new Error('Queued history unavailable');
      expect(users({ committed: history.data.turns, active: null })).toMatchObject([{ id: 'first-client' }, { id: 'timeout-client' }]);
      return;
    }
    expect(await admission).toMatchObject({ success: false, error: { cause: { code: 'prompt_admission_timeout' } } });
    expect(h.agent.closeSession).toHaveBeenCalledTimes(1);
    expect(runtime.adapterProvenance('conv-1')).toMatchObject({ closing: true });
    await h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'message', role: 'user', messageId: 'late-native', text: input.text } });
    native.resolve({ status: 'accepted', requestId: 'abandoned', messageId: 'late-native' });
    await vi.advanceTimersByTimeAsync(150);
    const history = runtime.getHistory('conv-1');
    if (!history.success) throw new Error('Closing history unavailable');
    const active = runtime.sessionLiveModels('conv-1')?.states.activeTurn.snapshot().data;
    expect(users({ committed: history.data.turns, active: active ?? null })).toMatchObject([{ id: 'timeout-client' }]);
    close.resolve({}); await vi.advanceTimersByTimeAsync(1);
    expect(h.lastChild.kill).toHaveBeenCalled();
  } finally { close.resolve({}); vi.useRealTimers(); await runtime.dispose(); }
});

it('keeps independently expanded delivery segments distinct despite their shared client identity', () => {
  const parent: ChatMessage = { kind: 'message', role: 'user', id: 'batch-client', text: 'batch',
    _meta: { guguClientMessageId: 'batch-client' } };
  const segments = ['msg:source-a', 'msg:source-b'].map((messageId, index): ChatMessage => ({
    ...parent, id: `${parent.id}:batch-${index}`,
    guguDelivery: readDeliveryEnvelope(`<gugu_delivery route="chat" msg="${messageId}"><![CDATA[body]]></gugu_delivery>`)!,
  }));
  expect(segments.map(conversationBubbleKey)).toEqual(['conversation-bubble:msg:source-a', 'conversation-bubble:msg:source-b']);
  const expanded = new Set([conversationBubbleKey(segments[0]!)]);
  expect(segments.map(item => expanded.has(conversationBubbleKey(item)))).toEqual([true, false]);
});

it('uses the stable client identity for a single unsplit bubble', () => {
  expect(conversationBubbleKey({ kind: 'message', role: 'user', id: 'display-prefix', text: 'body',
    _meta: { guguClientMessageId: 'client-owned' } })).toBe('conversation-bubble:client-owned');
});
