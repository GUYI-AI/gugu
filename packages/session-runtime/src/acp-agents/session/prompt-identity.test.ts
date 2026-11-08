import { describe, expect, it, vi } from 'vitest';
import type { SessionPromptReceipt } from '@gugu/session-core/acp';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';

const users = (history: ReturnType<SessionCell['history']>) => [...history.committed, ...(history.active ? [history.active] : [])]
  .flatMap(turn => turn.items.filter((item): item is Extract<typeof item, { kind: 'message' }> => item.kind === 'message' && item.role === 'user'));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture() {
  const receipts: ReturnType<typeof Promise.withResolvers<SessionPromptReceipt>>[] = [];
  const prompt = vi.fn(() => { const receipt = Promise.withResolvers<SessionPromptReceipt>(); receipts.push(receipt); return receipt.promise; });
  const snapshots: ReturnType<SessionCell['history']>[] = [];
  const cell = new SessionCell({ sessionId: 'identity', projectId: 'p', providerId: 'fixture', acpSessionId: 's',
    agent: { prompt, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger,
    callbacks: { onTranscriptChanged: () => snapshots.push(cell.history()) } });
  cell.applySessionReady();
  const echo = (id: string) => cell.push({ kind: 'message', role: 'user', messageId: id, text: 'identical body' });
  const idle = () => cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
  return { cell, prompt, receipts, snapshots, echo, idle };
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

  it.each(['prompt_admission_timeout', 'provider_failure'])('keeps an unconfirmed echo private after %s and reuses the client identity on retry', async code => {
    const p = fixture();
    try {
      const first = p.cell.promptDetached({ text: 'identical body', clientMessageId: 'retry-client' });
      await vi.waitFor(() => expect(p.prompt).toHaveBeenCalledTimes(1));
      p.echo('unconfirmed-native');
      p.receipts[0]!.reject(Object.assign(new Error('receipt failed'), { code }));
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
});
