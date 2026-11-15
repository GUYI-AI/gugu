import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { appendFile, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

type Row = { id?: string; runtime: string; provider: string; providerSessionId: string; agentStatus: string | null;
  archivedAt: string | null; config: { forkedFrom: { sessionId: string } } | undefined };
const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, root: '',
  row: undefined as unknown as Row, parent: null as Row | null,
  process: null as { home: 'host'; start: 'fresh' } | null, tmux: false,
  reads: [] as number[], beforeRead: null as ((count: number) => void) | null }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/session-timeline/service', () => ({
  readSessionRow: (id: string) => id === 'parent' ? state.parent : state.row,
  locateRow: (row: Row) => ({ supported: true, locator: { harness: row.provider, providerSessionId: row.providerSessionId, roots: [state.root] } }),
}));
vi.mock('@gugu/session-core/session-record/fill-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gugu/session-core/session-record/fill-read')>();
  return { ...actual, readRecordFrom: (input: Parameters<typeof actual.readRecordFrom>[0]) => {
    if (input.sessionId === 'c1') { state.reads.push(input.position); state.beforeRead?.(state.reads.length); }
    return actual.readRecordFrom(input);
  } };
});
vi.mock('@main/core/session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider: string) => provider }));
vi.mock('@main/core/session-timeline/write-bridge', () => ({ acpSessionLive: async () => false }));
vi.mock('./session-process', () => ({ sessionProcess: () => state.process,
  sessionEngine: async () => state.process ? 'owned' : state.tmux ? 'detached' : 'gone' }));

import { events } from '@main/lib/events';
import { onActivitySignal } from '../activity/signals';
import { syncStoredHistoryFromRecord } from './record-backfill';
import { getStoredToolImage, withStoredTurns } from './session-turn-store';
import { nativeConversationUnread } from './session-conversation-read';
import { nativeConversationActivity } from './session-conversation-activity';

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let fixture: Fixture;
const rows = () => fixture.sqlite.prepare('SELECT seq,data FROM session_turns ORDER BY seq').all() as { seq: number; data: string }[];
const texts = () => rows().map(row => (JSON.parse(row.data) as TranscriptTurn).items.flatMap(item => item.kind === 'message' ? [item.text] : []).join(' / '));
const outcomes = () => rows().map(row => (JSON.parse(row.data) as TranscriptTurn).outcome?.kind);

// A Codex rollout: its turns are matched by content, as the real runtime's rows are.
const THREAD = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
const line = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type, payload });
const codexTurn = (question: string, answer: string, done = true) => [
  line('event_msg', { type: 'task_started' }),
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] }),
  line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }),
  ...(done ? [line('event_msg', { type: 'task_complete' })] : []),
];
const qa = (n: number, done = true) => codexTurn(`question ${n}`, `answer ${n}`, done);
let record = '';
const writeRecord = async (lines: string[]) => {
  await writeFile(record, [line('session_meta', { id: THREAD, timestamp: '2026-06-18T07:03:21Z', cwd: '/work' }), ...lines].join('\n') + '\n');
};
const appendRecord = (lines: string[]) => appendFile(record, lines.join('\n') + '\n');
const sync = () => syncStoredHistoryFromRecord('c1', { runtime: 'pty' });

beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p1','P','/repo'); INSERT INTO sessions(id,project_id,title,runtime,agent_status) VALUES ('c1','p1','C','pty','idle');");
  state.row = { runtime: 'pty', provider: 'codex', providerSessionId: THREAD, agentStatus: 'idle', archivedAt: null, config: undefined };
  state.parent = null; state.process = null; state.tmux = false; state.reads = []; state.beforeRead = null;
  state.root = await mkdtemp(join(tmpdir(), 'record-backfill-'));
  await mkdir(join(state.root, '2026', '06', '18'), { recursive: true });
  record = join(state.root, '2026', '06', '18', `rollout-2026-06-18T07-03-21-${THREAD}.jsonl`);
  await writeRecord([...qa(0), ...qa(1)]);
  vi.mocked(events.emit).mockClear();
});
afterEach(async () => { fixture.close(); await rm(state.root, { recursive: true, force: true }); });

it('stores completed history without outcome metadata or live notification/activity/status facts, and skips an unchanged record', async () => {
  const activity = vi.fn();
  const off = onActivitySignal(activity);
  const before = fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1');
  const unread = await nativeConversationUnread('c1');
  try {
    expect(await sync()).toEqual({ inserted: 2, status: 'complete' });
    expect(texts()).toEqual(['question 0 / answer 0', 'question 1 / answer 1']);
    state.reads = [];
    expect(await sync()).toEqual({ inserted: 0, status: 'complete' });
    expect(state.reads).toEqual([]);
    expect(rows()).toHaveLength(2);
    expect(await nativeConversationUnread('c1')).toEqual(unread);
    expect(fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1')).toEqual(before);
    // Only the list projection changes: imported history is not a new unread/live message.
    expect(fixture.sqlite.prepare("SELECT key FROM kv WHERE key LIKE 'native-conversation-%'").all()).toEqual([{ key: 'native-conversation-activity:c1' }]);
    expect(vi.mocked(events.emit).mock.calls.map(([channel, data]) => [channel.name, data]))
      .toEqual(rows().map(() => ['session:changed', { sessionId: 'c1', projectId: 'p1', changes: { nativeLastMessage: true } }]));
    expect(activity).not.toHaveBeenCalled();
  } finally { off(); }
});

it('keeps an active suffix incomplete while persisting only the completed prefix', async () => {
  await writeRecord([...qa(0), ...qa(1, false)]);
  state.row.agentStatus = 'working';
  expect(await sync()).toEqual({ inserted: 1, status: 'active' });
  expect(texts()).toEqual(['question 0 / answer 0']);
  await appendRecord([line('event_msg', { type: 'task_complete' })]);
  state.row.agentStatus = 'idle';
  expect(await sync()).toEqual({ inserted: 1, status: 'complete' });
  expect(outcomes()).toEqual(['done', 'done']);
});

it.each([false, true])('finds a settled Claude reply after a live snapshot (earlier prompt row: %s)', async earlyPrompt => {
  const root = await mkdtemp(join(tmpdir(), 'claude-settled-backfill-'));
  const file = join(root, 'record.jsonl');
  const line = (uuid: string, role: 'user' | 'assistant', text: string) => JSON.stringify({
    type: role, uuid, parentUuid: role === 'user' ? null : 'question', sessionId: 'record',
    timestamp: '2026-10-31T00:00:00Z', message: { id: uuid, role, content: [{ type: 'text', text }],
      ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) },
  }) + '\n';
  await writeFile(file, line('question', 'user', 'The live prompt'));
  state.row.provider = 'claude'; state.row.providerSessionId = 'record'; state.root = root;
  const activity = vi.fn();
  const offActivity = onActivitySignal(activity);
  try {
    // Preserve/revise an actual early snapshot too: status notification can follow the record's prompt write.
    if (earlyPrompt) expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
    const before = rows();
    const sessionBefore = fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1');
    const unreadBefore = await nativeConversationUnread('c1');
    state.row.agentStatus = 'working';
    expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'active' });
    expect(rows()).toEqual(before);
    await appendFile(file, line('answer', 'assistant', 'SETTLEDREPLY'));
    state.row.agentStatus = 'idle';
    expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: earlyPrompt ? 0 : 1, status: 'complete' });
    const stored = rows() as { seq: number; data: string }[];
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].data)).toMatchObject({ id: 'c1:turn:s0', seq: 0, outcome: { kind: 'done' } });
    expect((JSON.parse(stored[0].data) as TranscriptTurn).items).toContainEqual(expect.objectContaining({ kind: 'message', role: 'assistant', text: 'SETTLEDREPLY' }));
    // Only the list projection changes: imported history is not a new unread/live message.
    expect(events.emit).toHaveBeenCalledTimes(earlyPrompt ? 2 : 1);
    for (const [channel, data] of vi.mocked(events.emit).mock.calls) {
      expect(channel.name).toBe('session:changed');
      expect(data).toEqual({ sessionId: 'c1', projectId: 'p1', changes: { nativeLastMessage: true } });
    }
    expect(nativeConversationActivity('c1')?.text).toBe('SETTLEDREPLY');
    expect(activity).not.toHaveBeenCalled();
    expect(await nativeConversationUnread('c1')).toEqual(unreadBefore);
    expect(fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1')).toEqual(sessionBefore);
    expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
    expect(rows()).toEqual(stored);
  } finally {
    offActivity(); await rm(root, { recursive: true, force: true });
  }
});

it.each(['error', 'archived'])('keeps the unfinished last turn of a %s PTY without inventing an outcome', async kind => {
  await writeRecord([...qa(0), ...qa(1, false)]);
  state.row.agentStatus = kind === 'archived' ? 'working' : 'error';
  state.row.archivedAt = kind === 'archived' ? '2026-10-31' : null;
  expect(await sync()).toEqual({ inserted: 2, status: 'complete' });
  expect(outcomes()).toEqual(['done', undefined]);
});

it('reports a live idle terminal whose last record turn has no outcome as settling, and final once its process is gone', async () => {
  state.process = { home: 'host', start: 'fresh' };
  await writeRecord([...qa(0), ...qa(1, false)]);
  expect(await sync()).toEqual({ inserted: 2, status: 'settling' });
  await appendRecord([line('event_msg', { type: 'task_complete' })]);
  expect(await sync()).toEqual({ inserted: 0, status: 'complete' });
  expect(outcomes()).toEqual(['done', 'done']);
  await appendRecord(qa(2)); state.process = null;
  expect(await sync()).toEqual({ inserted: 1, status: 'complete' });
});

it('keeps a restarted terminal whose engine is still in tmux settling before reattach, and completes it when the turn lands', async () => {
  // After a host restart the process table is empty until reattach; tmux still holds the running engine.
  state.tmux = true;
  await writeRecord(qa(0, false));
  expect(await sync()).toEqual({ inserted: 1, status: 'settling' });
  state.process = { home: 'host', start: 'fresh' };
  expect(await sync()).toEqual({ inserted: 0, status: 'settling' });
  await appendRecord([line('event_msg', { type: 'task_complete' })]);
  expect(await sync()).toEqual({ inserted: 0, status: 'complete' });
  expect(outcomes()).toEqual(['done']);
});

it('uses the owned process fact when no status source exists', async () => {
  state.row.agentStatus = null; state.process = { home: 'host', start: 'fresh' };
  await writeRecord([...qa(0), ...qa(1, false)]);
  expect(await sync()).toEqual({ inserted: 1, status: 'active' });
});

it('does not append an idle snapshot suffix if a turn starts during the read', async () => {
  // The second read is the one that writes.
  state.beforeRead = count => { if (count === 2) state.row.agentStatus = 'working'; };
  expect(await sync()).toEqual({ inserted: 0, status: 'active' });
  expect(rows()).toEqual([]);
});

it('resumes after cancellation from committed canonical rows without repeating an earlier turn', async () => {
  // Cancel right after the first committed row: the row commit itself calls back (a test-only SQLite trigger).
  const abort = new AbortController();
  fixture.sqlite.function('abort_backfill', () => { abort.abort(); return null; });
  fixture.sqlite.exec('CREATE TEMP TRIGGER abort_after_first AFTER INSERT ON session_turns BEGIN SELECT abort_backfill(); END');
  try {
    expect(await syncStoredHistoryFromRecord('c1', { signal: abort.signal, runtime: 'pty' })).toEqual({ inserted: 1, status: 'cancelled' });
  } finally { fixture.sqlite.exec('DROP TRIGGER abort_after_first'); }
  expect(rows()).toHaveLength(1);
  expect(await sync()).toEqual({ inserted: 1, status: 'complete' });
  expect(texts()).toEqual(['question 0 / answer 0', 'question 1 / answer 1']);
});

it('rechecks a presentation switch after waiting for the existing persistence queue', async () => {
  let release!: () => void;
  const prior = withStoredTurns('c1', () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const backfill = sync();
  state.row.runtime = 'acp'; release(); await prior;
  expect(await backfill).toEqual({ inserted: 0, status: 'runtime-changed' });
  expect(state.reads).toEqual([]);
  expect(rows()).toEqual([]);
});

it('reports missing, unsupported and divergent history without appending it', async () => {
  await rm(record);
  expect((await sync()).status).toBe('unavailable');
  state.row.provider = 'other';
  expect((await sync()).status).toBe('unsupported');
  state.row.provider = 'codex';
  await writeRecord([...qa(0), ...qa(1)]);
  expect(await sync()).toEqual({ inserted: 2, status: 'complete' });
  // Replaced: the cursor's turn is gone and nothing stored is in it.
  await writeRecord(codexTurn('different branch', 'other answer'));
  expect(await sync()).toEqual({ inserted: 0, status: 'diverged' });
  expect(rows()).toHaveLength(2);
});

it('does not write inherited history when the existing reader cannot prove the fork cut', async () => {
  // A Codex record has no lineage to prove a parent's prefix with.
  state.row.config = { forkedFrom: { sessionId: 'parent' } };
  state.parent = { ...state.row, config: undefined };
  expect(await sync()).toEqual({ inserted: 0, status: 'diverged' });
  expect(rows()).toEqual([]);
});

it('reads only from the cursor once a fill completed, and fills what the record grew by', async () => {
  await writeRecord(Array.from({ length: 300 }, (_, n) => qa(n)).flat());
  expect(await sync()).toEqual({ inserted: 300, status: 'complete' });
  expect(state.reads).toEqual([0, 0]);
  const size = (await readFile(record)).length;
  state.reads = [];
  await appendRecord([...qa(300), ...qa(301)]);
  expect(await sync()).toEqual({ inserted: 2, status: 'complete' });
  // Both passes start at the last stored turn, near the old end.
  expect(state.reads).toHaveLength(2);
  expect(state.reads[0]).toBe(state.reads[1]);
  expect(state.reads[0]).toBeGreaterThan(size - 1024);
  expect(texts().slice(-3)).toEqual(['question 299 / answer 299', 'question 300 / answer 300', 'question 301 / answer 301']);
});

it('fills new turns that repeat stored ones exactly as a whole-record match does', async () => {
  // Content identities: a window from inside the record could take the repeats for the stored turns.
  await writeRecord([...codexTurn('x', 'y'), ...codexTurn('again', 'same'), ...codexTurn('more', 'same too')]);
  expect(await sync()).toEqual({ inserted: 3, status: 'complete' });
  await appendRecord([...codexTurn('again', 'same'), ...codexTurn('more', 'same too')]);
  expect(await sync()).toEqual({ inserted: 2, status: 'complete' });
  expect(rows()).toHaveLength(5);
});

it('matches a rewound record from its beginning, as before', async () => {
  // Rewind: the record loses its last turn and grows another one; the cursor's turn is no longer where it was.
  await writeRecord([...qa(0), ...qa(1), ...qa(2)]);
  expect(await sync()).toEqual({ inserted: 3, status: 'complete' });
  const kept = [line('session_meta', { id: THREAD, timestamp: '2026-06-18T07:03:21Z', cwd: '/work' }), ...qa(0), ...qa(1)].join('\n') + '\n';
  await truncate(record, Buffer.byteLength(kept));
  await appendRecord(qa(3));
  state.reads = [];
  expect(await sync()).toEqual({ inserted: 1, status: 'complete' });
  expect(state.reads.at(-1)).toBe(0);
  expect(texts()).toEqual(['question 0 / answer 0', 'question 1 / answer 1', 'question 2 / answer 2', 'question 3 / answer 3']);
});

it('stores only a proved Claude fork increment after canonical storage renumbers it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fork-backfill-'));
  const line = (uuid: string, parentUuid: string | null, role: string, text: string) => JSON.stringify({
    type: role, uuid, parentUuid, isSidechain: false, sessionId: 'child', timestamp: '2026-10-31T00:00:00Z',
    message: { id: uuid, role, content: [{ type: 'text', text }], ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) },
  });
  const common = [line('p0', null, 'user', 'parent question'), line('p1', 'p0', 'assistant', 'parent answer')];
  await mkdir(join(root, 'records'));
  await writeFile(join(root, 'records', 'parent.jsonl'), common.join('\n') + '\n');
  await writeFile(join(root, 'records', 'child.jsonl'), [...common, line('c0', 'p1', 'user', 'child question'),
    line('c1', 'c0', 'assistant', 'child answer')].join('\n') + '\n');
  try {
    state.root = root;
    state.row.provider = 'claude'; state.row.providerSessionId = 'child'; state.row.config = { forkedFrom: { sessionId: 'parent' } };
    state.parent = { ...state.row, provider: 'claude', providerSessionId: 'parent', config: undefined };
    expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
    const stored = rows() as { seq: number; data: string }[];
    const texts = stored.flatMap(row => (JSON.parse(row.data) as TranscriptTurn).items.map(item => 'text' in item ? item.text : ''))
    expect(texts.join(' ')).not.toContain('parent');
    expect(texts.filter(text => text.startsWith('child'))).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('stores filled-in pictures as their place in the record and reads them back, also once the record is archived', async () => {
  const picture = (n: number) => String(n).padStart(4, '0').repeat(20_000);
  const pictureTurn = (n: number) => [
    line('event_msg', { type: 'task_started' }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `question ${n}` }] }),
    line('response_item', { type: 'function_call', name: 'shot', arguments: '{}', call_id: `shot-${n}` }),
    line('response_item', { type: 'function_call_output', call_id: `shot-${n}`, output: [{ type: 'input_image', image_url: `data:image/png;base64,${picture(n)}` }] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${n}` }] }),
    line('event_msg', { type: 'task_complete' }),
  ];
  type Tool = { id: string; images?: unknown[]; imageRefs?: Array<{ chars: number; record?: { start: number } }> };
  const tools = () => rows().map(row => ({ seq: row.seq, tool: (JSON.parse(row.data) as TranscriptTurn).items.find(item => item.kind !== 'message') as unknown as Tool }));
  const opened = async () => {
    const shown: string[] = [];
    for (const { seq, tool } of tools()) {
      const found = await getStoredToolImage({ sessionId: 'c1', seq, itemId: tool.id, index: 0 });
      shown.push(found.ok ? found.image.data.slice(0, 8) + ':' + found.image.data.length : found.code);
    }
    return shown;
  };
  await writeRecord([0, 1, 2].flatMap(pictureTurn));
  expect(await sync()).toEqual({ inserted: 3, status: 'complete' });
  expect(tools().map(({ tool }) => [tool.images, tool.imageRefs?.[0]?.chars, typeof tool.imageRefs?.[0]?.record?.start])).toEqual([
    [undefined, 80_000, 'number'], [undefined, 80_000, 'number'], [undefined, 80_000, 'number']]);
  expect(await opened()).toEqual([0, 1, 2].map(n => `${picture(n).slice(0, 8)}:80000`));
  // The cursor reads on past pictures left in the record.
  await appendRecord([3, 4].flatMap(pictureTurn));
  expect(await sync()).toEqual({ inserted: 2, status: 'complete' });
  expect(texts().at(-1)).toBe('question 4 / answer 4');
  // Codex archives an old rollout as `.zst`: the same decoded offsets, read back by streaming it.
  await writeFile(`${record}.zst`, zstdCompressSync(await readFile(record)));
  await rm(record);
  expect(await opened()).toEqual([0, 1, 2, 3, 4].map(n => `${picture(n).slice(0, 8)}:80000`));
  // A record that no longer has the picture: only its size, as before.
  await writeFile(`${record}.zst`, zstdCompressSync(Buffer.from(line('session_meta', { id: THREAD }) + '\n')));
  expect(await opened()).toEqual(Array(5).fill('no_such_image'));
});
