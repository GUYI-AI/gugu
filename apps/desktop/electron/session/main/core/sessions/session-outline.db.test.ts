import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { OUTLINE_REPLY_CHARS, outlineOfMessages, type OutlineMessageRow } from '@shared/core/sessions/session-outline';

// The rail of a window that has loaded one page still shows the whole conversation: the machine that keeps it reads
// an outline off the stored turns. What is pinned here is that the outline is the stored turns' own reading (the same
// one a loaded turn gets), that it stops at the turn the window already has, and that a long conversation is read
// whole, in order.

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
  get sqlite() {
    if (!mocks.sqlite) throw new Error('Test database not initialized');
    return mocks.sqlite;
  },
}));

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { getStoredOutline } from './session-outline';
import { appendRecordTurnNow } from './session-turn-store';

type Fixture = Awaited<ReturnType<typeof openFixture>>;
type Item = TranscriptTurn['items'][number];

const msg = (id: string, role: 'user' | 'assistant', text: string) => ({ kind: 'message', id, seq: 0, role, text }) as Item;
const tool = (id: string) => ({ kind: 'execute-tool-call', id, seq: 0, toolCallId: id, title: 'ls', command: 'ls', status: 'done', output: 'x'.repeat(4_000) }) as unknown as Item;
const turn = (id: string, initiator: 'user' | 'agent', items: Item[]): TranscriptTurn => ({ id, seq: 0, initiator, items }) as TranscriptTurn;
const delivery = (fromType: 'human' | 'agent', content: string) => renderDeliveryEnvelope({
  route: 'chat', from: fromType === 'human' ? 'Ada' : 'Worker', fromId: fromType === 'human' ? 'user:ada' : 'user:worker', fromType,
  messageId: `msg:${content}`, at: '2026-11-03', chat: '7', chatKind: 'group', content,
});

/** The stored turns as a window that had loaded them would hold them. */
const stored = (fixture: Fixture, sessionId: string) => (fixture.sqlite
  .prepare('SELECT seq, data FROM session_turns WHERE session_id = ? ORDER BY seq').all(sessionId) as { seq: number; data: string }[])
  .map(row => ({ ...(JSON.parse(row.data) as TranscriptTurn), seq: row.seq }));
const rowsOf = (turns: readonly TranscriptTurn[]): OutlineMessageRow[] => turns.flatMap(one => one.items.flatMap(item => item.kind === 'message'
  ? [{ seq: one.seq, turnId: one.id, referenceId: one.referenceId ?? null, initiator: one.initiator, itemId: item.id, role: item.role, text: item.text }] : []));

describe('the outline of a stored conversation', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.sqlite = fixture.sqlite;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id) VALUES ('c1', 'p1');
      INSERT INTO sessions (id, project_id) VALUES ('c2', 'p1');
    `);
  });

  afterEach(() => { fixture.close(); vi.clearAllMocks(); });

  it('reads what a rail would read off the same turns, loaded', async () => {
    appendRecordTurnNow('c1', turn('r:0', 'user', [msg('u', 'user', 'typed ask'), tool('t'), msg('a', 'assistant', 'the reply'), msg('b', 'assistant', 'more')]));
    appendRecordTurnNow('c1', turn('r:1', 'agent', [msg('u', 'user', delivery('human', 'from a person')), msg('a', 'assistant', 'answer')]));
    appendRecordTurnNow('c1', turn('r:2', 'agent', [msg('u', 'user', delivery('agent', 'from an agent')), msg('a', 'assistant', 'answer')]));
    appendRecordTurnNow('c1', turn('r:3', 'user', [msg('u1', 'user', 'one'), msg('a1', 'assistant', 'first'), msg('u2', 'user', 'two'), msg('a2', 'assistant', 'second')]));
    appendRecordTurnNow('c1', turn('r:4', 'user', [msg('u', 'user', 'the newest, already loaded'), msg('a', 'assistant', 'ok')]));
    appendRecordTurnNow('c2', turn('r:0', 'user', [msg('u', 'user', 'another conversation'), msg('a', 'assistant', 'ok')]));

    const turns = stored(fixture, 'c1');
    const before = turns.at(-1)!.seq;
    const { turns: outline } = await getStoredOutline({ sessionId: 'c1', before });

    expect(outline).toEqual(outlineOfMessages(rowsOf(turns.filter(one => one.seq < before))));
    // The agent's delivery is nobody's question; the turn the window has loaded is the window's own to draw.
    expect(outline.map(one => one.inputs.map(input => input.candidates.map(candidate => candidate.text))))
      .toEqual([[['typed ask']], [['from a person']], [['one'], ['two']]]);
    expect(outline.map(one => one.inputs.map(input => input.reply))).toEqual([['the reply'], ['answer'], ['first', 'second']]);
    expect(outline[0]!.inputs[0]!.itemId).toBe(turns[0]!.items[0]!.id);
  });

  it('sends the start of a long reply, not the reply', async () => {
    appendRecordTurnNow('c1', turn('r:0', 'user', [msg('u', 'user', 'ask'), msg('a', 'assistant', 'word '.repeat(40_000))]));
    const { turns: outline } = await getStoredOutline({ sessionId: 'c1', before: Number.MAX_SAFE_INTEGER });
    expect(outline[0]!.inputs[0]!.reply).toHaveLength(OUTLINE_REPLY_CHARS);
    expect(JSON.stringify(outline).length).toBeLessThan(1_000);
  });

  it('reads a long conversation whole and in order', async () => {
    for (let index = 0; index < 180; index += 1) appendRecordTurnNow('c1', turn(`r:${index}`, 'user', [msg('u', 'user', `ask ${index}`), msg('a', 'assistant', `reply ${index}`)]));
    const turns = stored(fixture, 'c1');
    const before = turns[170]!.seq;
    const { turns: outline } = await getStoredOutline({ sessionId: 'c1', before });
    expect(outline.map(one => one.inputs[0]!.candidates[0]!.text)).toEqual(Array.from({ length: 170 }, (_unused, index) => `ask ${index}`));
    expect(outline.map(one => one.seq)).toEqual(turns.slice(0, 170).map(one => one.seq));
  });

  it('has nothing to say when the window holds the first turn, or the conversation is empty', async () => {
    expect(await getStoredOutline({ sessionId: 'c1', before: Number.MAX_SAFE_INTEGER })).toEqual({ turns: [] });
    appendRecordTurnNow('c1', turn('r:0', 'user', [msg('u', 'user', 'ask')]));
    expect(await getStoredOutline({ sessionId: 'c1', before: stored(fixture, 'c1')[0]!.seq })).toEqual({ turns: [] });
  });
});
