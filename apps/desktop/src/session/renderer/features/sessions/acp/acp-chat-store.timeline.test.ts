// @vitest-environment jsdom
/**
 * The session page draws the session's timeline: what it reads at open, what the host pushes after, and the running
 * turn from the live session. A turn just committed stays on screen until the timeline holds its recorded form.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { host, installAcpChatStoreHost, replica } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');

const turn = (id: string, seq: number, text: string, startedAt = seq * 100): TranscriptTurn => ({
  id, seq, initiator: 'user', startedAt, items: [{ kind: 'message', id: `${id}:m`, seq: 0, role: 'user', text, at: startedAt }],
});
type Internals = {
  session: { activeTurn: ReturnType<typeof replica<TranscriptTurn | null>> } | null;
  _historyGeneration: number;
  _committedFrameId: string | null;
  _openHistory(generation: number): Promise<void>;
};
const stores: InstanceType<typeof AcpChatStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) { (store as unknown as Internals).session = null; store.dispose(); } });

async function opened(turns: TranscriptTurn[]) {
  host.show(turns);
  const store = new AcpChatStore('s', 'p');
  stores.push(store);
  const internal = store as unknown as Internals;
  await internal._openHistory(internal._historyGeneration);
  return { store, internal };
}
const committedIds = (store: InstanceType<typeof AcpChatStore>) => store.chatState.transcript.state.committedTurns.map((t) => t.id);

it('draws what the timeline holds, and each snapshot the host pushes after', async () => {
  const { store } = await opened([turn('a', 0, 'one'), turn('b', 1, 'two')]);
  expect(committedIds(store)).toEqual(['a', 'b']);
  expect(store.historyLoading).toBe(false);
  host.show([turn('a', 0, 'one'), turn('b', 1, 'two'), turn('c', 2, 'three')]);
  expect(committedIds(store)).toEqual(['a', 'b', 'c']);
});

it('lets a committed frame go once the timeline holds that turn ended under the same id (a journaled turn)', async () => {
  const live = turn('runtime-1', 1, 'go');
  const { store, internal } = await opened([turn('a', 0, 'one'), live]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(live) };
  host.show([turn('a', 0, 'one'), live]);
  internal.session.activeTurn.push(null);
  internal._committedFrameId = 'runtime-1';
  host.show([turn('a', 0, 'one'), { ...live, endedAt: 300, outcome: { kind: 'done' } }]);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
  expect(committedIds(store)).toEqual(['a', 'runtime-1']);
});

it('leaves the running turn to the live session and keeps a committed one until its recorded form arrives', async () => {
  const live = turn('runtime-1', 2, 'go');
  const { store, internal } = await opened([turn('a', 0, 'one'), live]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(live) };
  host.show([turn('a', 0, 'one'), live]);
  expect(committedIds(store)).toEqual(['a']);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('runtime-1');

  // Committed: the live session lets go, the frame stays while the timeline still carries the runtime's copy.
  internal.session.activeTurn.push(null);
  internal._committedFrameId = 'runtime-1';
  host.show([turn('a', 0, 'one'), live]);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('runtime-1');
  expect(committedIds(store)).toEqual(['a']);

  // The recorded form replaces it: one turn, ❌ both.
  host.show([turn('a', 0, 'one'), turn('s:node-7', 2, 'go')]);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
  expect(committedIds(store)).toEqual(['a', 's:node-7']);
});

it('puts an owner notification made by the running turn into that turn', async () => {
  const live = turn('runtime-1', 1, 'work');
  const notice: TranscriptTurn = { id: 'owner-notify:r', seq: 2, initiator: 'agent', startedAt: 150, items: [
    { kind: 'message', id: 'owner-notify:r:m', seq: 0, role: 'assistant', text: 'Review', at: 150,
      ownerNotification: { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 'runtime-1' } },
  ] };
  const { store, internal } = await opened([turn('a', 0, 'one')]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(live) };
  host.show([turn('a', 0, 'one'), live, notice]);
  expect(committedIds(store)).toEqual(['a']);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.items.map((item) => item.id)).toEqual(['runtime-1:m', 'owner-notify:r:m']);
});
