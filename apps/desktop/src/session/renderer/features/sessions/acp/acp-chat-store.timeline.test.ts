// @vitest-environment jsdom
/**
 * The session page draws the session's timeline: what it reads at open, what the host pushes after, and the running
 * turn from the live session. A turn just committed stays on screen while the timeline holds it open.
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
  _committedFrame: TranscriptTurn | null;
  _endedBeforeLive: ReadonlySet<string>;
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
  internal._committedFrame = live;
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
  internal._committedFrame = live;
  host.show([turn('a', 0, 'one'), live]);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('runtime-1');
  expect(committedIds(store)).toEqual(['a']);

  // The record has its prompt and not yet its reply: the frame stays.
  host.show([turn('a', 0, 'one'), turn('s:node-7', 2, 'go')]);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('runtime-1');
  expect(committedIds(store)).toEqual(['a']);

  // The recorded form, ended, replaces it: one turn, ❌ both.
  host.show([turn('a', 0, 'one'), { ...turn('s:node-7', 2, 'go'), outcome: { kind: 'done' } }]);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
  expect(committedIds(store)).toEqual(['a', 's:node-7']);
});

it('keeps the first completed turn while the host timeline still has no copy of it', async () => {
  const prompt = turn('runtime-first', 0, 'first question');
  const first: TranscriptTurn = {
    ...prompt,
    items: [...prompt.items, { kind: 'message', id: 'reply', seq: 1, role: 'assistant', text: 'first answer', at: 10 }],
  };
  const { store, internal } = await opened([]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(first) };
  host.show([]);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.items).toEqual(first.items);

  internal.session.activeTurn.push(null);
  internal._committedFrame = first;
  host.show([]);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.items).toEqual(first.items);

  const recorded = { ...first, id: 'recorded-first', endedAt: 20, outcome: { kind: 'done' as const } };
  host.show([recorded]);
  expect(committedIds(store)).toEqual(['recorded-first']);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
});

it('keeps a committed turn where it was while the next one starts, until the record holds it ended', async () => {
  const first = turn('runtime-1', 1, 'go');
  const { store, internal } = await opened([turn('a', 0, 'one'), first]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(first) };
  host.show([turn('a', 0, 'one'), first]);
  internal.session.activeTurn.push(null);
  internal._committedFrame = first;
  // The next turn starts while the record holds the first one's prompt only, and already the next one's (the runtime's
  // copy of it has none yet): ❌ the next one drawn in its place.
  const next: TranscriptTurn = { ...turn('runtime-2', 2, 'more'), items: [] };
  internal.session.activeTurn.push(next);
  host.show([turn('a', 0, 'one'), turn('s:node-7', 1, 'go'), turn('s:node-8', 2, 'more'), next]);
  expect(committedIds(store)).toEqual(['a', 'runtime-1', 's:node-8']);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('runtime-2');
  host.show([turn('a', 0, 'one'), { ...turn('s:node-7', 1, 'go'), outcome: { kind: 'done' } }, turn('s:node-8', 2, 'more'), next]);
  expect(committedIds(store)).toEqual(['a', 's:node-7', 's:node-8']);
});

it('lets a committed turn go when the record holds it in a form it cannot be told by', async () => {
  // Nothing shared yet (the record wrote the prompt as it arrived, with its delivery wrapper): ❌ both drawn.
  const first = turn('runtime-1', 1, 'go');
  const { store, internal } = await opened([turn('a', 0, 'one'), first]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(first) };
  host.show([turn('a', 0, 'one'), first]);
  internal.session.activeTurn.push(null);
  internal._committedFrame = first;
  host.show([turn('a', 0, 'one'), turn('s:node-9', 1, '[queued] go')]);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
  expect(committedIds(store)).toEqual(['a', 's:node-9']);
});

it('keeps a committed turn before the next one when the timeline holds the next one first', async () => {
  // The host timeline has the next turn running before this replica does: the committed one is drawn before it, ❌ after.
  const first = turn('runtime-1', 1, 'go');
  const { store, internal } = await opened([turn('a', 0, 'one'), first]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(first) };
  host.show([turn('a', 0, 'one'), first]);
  internal.session.activeTurn.push(null);
  internal._committedFrame = first;
  host.show([turn('a', 0, 'one'), turn('s:node-7', 1, 'go'), turn('runtime-2', 2, 'more')]);
  expect(committedIds(store)).toEqual(['a', 'runtime-1', 'runtime-2']);
  expect(store.chatState.transcript.state.activeTurnSnapshot).toBeNull();
});

it('draws the running turn once when the record already holds its own copy of it', async () => {
  // The record numbers the turn itself (another turn id) and is ahead of the live session; the agent's reply id is shared.
  const reply = (id: string): TranscriptTurn['items'][number] => ({ kind: 'message', id: `${id}:message:m-1`, seq: 1, role: 'assistant', text: 'ok', at: 150 });
  const live = { ...turn('runtime-1', 1, 'go'), items: [...turn('runtime-1', 1, 'go').items, reply('runtime-1')] };
  const { store, internal } = await opened([turn('a', 0, 'one')]);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(live) };
  host.show([turn('a', 0, 'one'), { ...turn('s:node-7', 1, 'go'), items: [...turn('s:node-7', 1, 'go').items, reply('s:node-7')] }]);
  expect(committedIds(store)).toEqual(['a']);
  expect(store.chatState.transcript.state.activeTurnSnapshot?.id).toBe('runtime-1');
});

it('keeps an earlier turn that opens with the same words as the running one', async () => {
  // `a` had ended when the running turn started (taken as it starts, `_endedBeforeLive`); the record's copy came after.
  const live = turn('runtime-2', 1, 'ok');
  const ended = { ...turn('a', 0, 'ok'), outcome: { kind: 'done' as const } };
  const { store, internal } = await opened([ended]);
  internal._endedBeforeLive = new Set(['a']);
  internal.session = { activeTurn: replica<TranscriptTurn | null>(live) };
  host.show([ended, turn('s:node-8', 1, 'ok')]);
  expect(committedIds(store)).toEqual(['a']);
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
