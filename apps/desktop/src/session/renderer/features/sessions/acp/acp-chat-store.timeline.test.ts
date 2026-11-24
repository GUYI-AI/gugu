// @vitest-environment jsdom
/**
 * The session page draws the session's timeline, and only it: what it reads at open, what the host pushes after, and
 * the turn the host says is running (`runningTurnId`) in the running slot.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { observeCommittedTurns } from '@renderer/lib/session-output-observers';
import { host, installAcpChatStoreHost } from './acp-chat-store.test-host';

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: () => {} }));
installAcpChatStoreHost();
const { AcpChatStore } = await import('./acp-chat-store');

const turn = (id: string, seq: number, text: string, startedAt = seq * 100): TranscriptTurn => ({
  id, seq, initiator: 'user', startedAt, items: [{ kind: 'message', id: `${id}:m`, seq: 0, role: 'user', text, at: startedAt }],
});
type Internals = { _historyGeneration: number; _openHistory(generation: number): Promise<void> };
const stores: InstanceType<typeof AcpChatStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });

async function opened(turns: TranscriptTurn[], running?: string | null) {
  host.show(turns, running);
  const store = new AcpChatStore('s', 'p');
  stores.push(store);
  const internal = store as unknown as Internals;
  await internal._openHistory(internal._historyGeneration);
  return store;
}
const committedIds = (store: InstanceType<typeof AcpChatStore>) => store.chatState.transcript.state.committedTurns.map((t) => t.id);
const runningId = (store: InstanceType<typeof AcpChatStore>) => store.chatState.transcript.state.activeTurnSnapshot?.id ?? null;

it('draws what the timeline holds, and each snapshot the host pushes after', async () => {
  const store = await opened([turn('a', 0, 'one'), turn('b', 1, 'two')], null);
  expect(committedIds(store)).toEqual(['a', 'b']);
  expect(store.historyLoading).toBe(false);
  host.show([turn('a', 0, 'one'), turn('b', 1, 'two'), turn('c', 2, 'three')], null);
  expect(committedIds(store)).toEqual(['a', 'b', 'c']);
});

it('draws the running turn in the running slot, and as history in the same draw once it ends', async () => {
  const live = turn('runtime-1', 1, 'go');
  const seen: unknown[] = [];
  const stop = observeCommittedTurns((_target, ended) => seen.push(ended));
  const store = await opened([turn('a', 0, 'one'), live], 'runtime-1');
  expect(committedIds(store)).toEqual(['a']);
  expect(runningId(store)).toBe('runtime-1');
  // The host keeps the runtime's last frame until the record holds the turn ended: the same turn, now not running.
  host.show([turn('a', 0, 'one'), live], null);
  expect(committedIds(store)).toEqual(['a', 'runtime-1']);
  expect(runningId(store)).toBeNull();
  expect(seen, 'the turn observers read the turn that ended, as last drawn').toHaveLength(1);
  stop();
});

it('draws every turn as history when the host does not say which one is running (an older host)', async () => {
  const store = await opened([turn('a', 0, 'one'), turn('runtime-1', 1, 'go')]);
  expect(committedIds(store)).toEqual(['a', 'runtime-1']);
  expect(runningId(store)).toBeNull();
});

it('puts an owner notification made by the running turn into that turn', async () => {
  const live = turn('runtime-1', 1, 'work');
  const notice: TranscriptTurn = { id: 'owner-notify:r', seq: 2, initiator: 'agent', startedAt: 150, items: [
    { kind: 'message', id: 'owner-notify:r:m', seq: 0, role: 'assistant', text: 'Review', at: 150,
      ownerNotification: { requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 'runtime-1' } },
  ] };
  const store = await opened([turn('a', 0, 'one')], null);
  host.show([turn('a', 0, 'one'), live, notice], 'runtime-1');
  expect(committedIds(store)).toEqual(['a']);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.items.map((item) => item.id)).toEqual(['runtime-1:m', 'owner-notify:r:m']);
});
