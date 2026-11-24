// @vitest-environment jsdom
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAcpChatStoreHost } from './acp-chat-store.test-host';

const reload = vi.hoisted(() => vi.fn());
vi.mock('../request-session-reload', () => ({ requestSessionReload: reload }));

installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');
const { sessionRegistry } = await import('../stores/session-registry');

function prepare(effort?: string, outcome: TranscriptTurn['outcome'] = {
  kind: 'error', reason: 'prompt_failed', thinkingRejected: true,
}, thinkingDisabled = false) {
  const store = new AcpChatStore('conversation', 'project');
  const turn: TranscriptTurn = {
    id: 'turn', seq: 1, initiator: 'user', trigger: { kind: 'owner' }, outcome,
    items: [{ id: 'prompt', seq: 0, kind: 'message', role: 'user', text: 'The original prompt' }],
  };
  vi.spyOn(sessionRegistry, 'get').mockReturnValue({ sessions: new Map([
    [store.sessionId, { data: { effort, thinkingDisabled } }],
  ]) } as unknown as ReturnType<typeof sessionRegistry.get>);
  store.chatState.transcript.history.seed([turn]);
  runInAction(() => { store.transcriptRevision += 1; });
  return { store, submit: vi.spyOn(store, 'submitPrompt').mockResolvedValue(undefined) };
}

afterEach(() => {
  reload.mockReset();
  vi.restoreAllMocks();
});

describe('retry without the rejected thinking level', () => {
  it('clears the explicit level before replaying the failed prompt once', async () => {
    const { store, submit } = prepare('medium');
    expect(store.rejectedThinkingTurnId).toBe('turn');
    reload.mockResolvedValue({ ok: true });
    await Promise.all([store.retryWithoutThinking('turn'), store.retryWithoutThinking('turn')]);
    expect(reload).toHaveBeenCalledExactlyOnceWith({ sessionId: store.sessionId, reason: 'thinking-retry', effort: null });
    expect(submit).toHaveBeenCalledExactlyOnceWith('The original prompt', [], undefined, undefined, undefined);
    expect(store.rejectedThinkingTurnId).toBeNull();
  });

  it('keeps the prompt available when the host cannot clear the level', async () => {
    const { store, submit } = prepare('medium');
    reload.mockResolvedValue({ ok: false, error: 'reload failed' });
    await expect(store.retryWithoutThinking('turn')).rejects.toThrow('reload failed');
    expect(submit).not.toHaveBeenCalled();
    expect(store.rejectedThinkingTurnId).toBe('turn');
  });

  it('offers no recovery for an absent level or an unrelated failure', () => {
    expect(prepare().store.rejectedThinkingTurnId).toBeNull();
    expect(prepare('medium', { kind: 'error', reason: 'prompt_failed' }).store.rejectedThinkingTurnId).toBeNull();
  });

  it('restores an explicit level when the user selects one after turning thinking off', async () => {
    const { store, submit } = prepare(undefined, undefined, true);
    reload.mockResolvedValue({ ok: true });
    expect(store.effort).toBeNull();
    await expect(store.setEffort('high')).resolves.toEqual({ kind: 'applied', effectiveValue: 'high' });
    expect(reload).toHaveBeenCalledExactlyOnceWith({ sessionId: store.sessionId, reason: 'thinking-retry', effort: 'high' });
    expect(submit).not.toHaveBeenCalled();
  });
});
