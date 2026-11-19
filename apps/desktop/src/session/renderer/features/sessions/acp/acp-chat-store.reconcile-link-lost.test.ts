// @vitest-environment jsdom
// A turn commits, and the reconciliation that would move it into history loses the connection
// (2026-11-12: a long reply vanished mid-screen). The turn stays visible until the link is back,
// then the same reconciliation runs again and history takes it over.
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { HistoryPage } from '@gugu/session-core/acp/client';
import { installAcpChatStoreHost, replica } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');

const answer: TranscriptTurn = { id: 'A', seq: 0, initiator: 'user', items: [
  { kind: 'message', id: 'A:question', seq: 0, role: 'user', text: 'Question A' },
  { kind: 'message', id: 'A:answer', seq: 1, role: 'assistant', text: 'A long answer with $x^2$' },
] };

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

function disconnected(): Error {
  return Object.assign(new Error('Wire transport disconnected'), { name: 'WireError', code: 'DISCONNECTED' });
}

for (const shape of ['thrown', 'result'] as const) {
  it(`keeps the committed turn on screen while the link is down (${shape}), then reconciles once it is back`, async () => {
    const activeTurn = replica<TranscriptTurn | null>(answer);
    let reconnect!: () => void;
    const whenConnected = vi.fn(() => new Promise<number>((resolve) => { reconnect = () => resolve(1); }));
    const page: { success: true; data: HistoryPage } = { success: true, data: {
      turns: [{ ...answer, outcome: { kind: 'done' } }], count: 1, nextCursor: null, cursor: { epoch: 'runtime', seq: 1 }, reset: false,
    } };
    const getHistory = vi.fn()
      .mockImplementationOnce(() => shape === 'thrown' ? Promise.reject(disconnected()) : Promise.resolve({ success: false, error: disconnected() }))
      .mockImplementation(() => Promise.resolve(page));
    const session = {
      canSyncDraft: () => true,
      onDraftSyncReady: () => () => {},
      activeTurn,
      sessionState: replica({ lifecycle: 'working', activeTurnId: answer.id, isGenerating: true, queuedPrompts: [], pendingPermissions: [] }),
      agents: replica([]), config: replica({}), plan: replica(null), terminals: replica([]), draft: replica(null),
      getHistory, whenConnected,
      dispose() {},
    };
    const store = new AcpChatStore(`reconcile-link-lost-${shape}`, 'project');
    cleanup.push(() => store.dispose());
    const internals = store as unknown as { session: unknown; _runtimeCursor: unknown; _subscribeLiveSession(value: unknown): void };
    internals.session = session;
    internals._runtimeCursor = { epoch: 'runtime', seq: 0 };
    internals._subscribeLiveSession(session);

    activeTurn.push(null);
    await vi.waitFor(() => expect(whenConnected).toHaveBeenCalledTimes(1));
    expect(store.chatState.transcript.state.activeTurnSnapshot?.id, 'the streamed turn must not vanish').toBe('A');
    expect(store.chatState.transcript.findItemById('A:answer')).toMatchObject({ text: 'A long answer with $x^2$' });
    expect(store.reconcileAwaitingLink).toBe(true);
    expect(getHistory).toHaveBeenCalledTimes(1);

    reconnect();
    await vi.waitFor(() => expect(store.chatState.transcript.state.committedTurns.map((t) => t.id)).toEqual(['A']));
    expect(getHistory).toHaveBeenCalledTimes(2);
    expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
    expect(store.reconcileAwaitingLink).toBe(false);
  });
}
