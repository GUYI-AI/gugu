import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRecordSource, createSessionTimeline } from '@gugu/session-core/session-record';
import type { RecordLineageNode } from '@gugu/session-core/session-record';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined,
  row: { runtime: 'pty', provider: 'codex', providerSessionId: 'record', agentStatus: 'idle' as string | null,
    archivedAt: null as string | null, config: undefined as { forkedFrom: { sessionId: string } } | undefined },
  process: null as { home: 'host'; start: 'fresh' } | null, tmux: false,
  turns: [] as TranscriptTurn[], committed: null as TranscriptTurn[] | null, available: true, pick: vi.fn(),
  /** The ingest's record read: state-driven by default, a real file reader in the file-based cases. */
  read: vi.fn(), requests: [] as IngestRequest[], root: '', parentLineage: null as readonly RecordLineageNode[] | null }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/session-timeline/service', () => ({
  readSessionRow: (id: string) => id === 'parent' ? { ...state.row, id: 'parent', providerSessionId: 'parent', config: undefined } : state.row,
  pickRecordTurns: state.pick,
  locateRow: (row: { provider: string; providerSessionId: string }) => ({ supported: true,
    locator: { harness: row.provider, providerSessionId: row.providerSessionId, roots: [state.root] } }),
}));
vi.mock('@main/core/session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider: string) => provider }));
vi.mock('@main/core/session-timeline/write-bridge', () => ({ acpSessionLive: async () => false }));
vi.mock('./session-process', () => ({ sessionProcess: () => state.process,
  sessionEngine: async () => state.process ? 'owned' : state.tmux ? 'detached' : 'gone' }));

import { events } from '@main/lib/events';
import { onActivitySignal } from '../activity/signals';
import { setRecordIngest, syncStoredHistoryFromRecord } from './record-backfill';
import { runIngest, type IngestRequest } from './record-ingest/plan';
import { readRecordForIngest } from '@gugu/session-core/session-record/ingest';
import { SessionRecordNotFoundError } from '@gugu/session-core/session-record';
import { buildSystemNoticeEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { withStoredTurns } from './session-turn-store';
import { nativeConversationUnread } from './session-conversation-read';
import { nativeConversationActivity } from './session-conversation-activity';

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let fixture: Fixture;
const turn = (seq: number): TranscriptTurn => ({ id: `c1:turn:${seq}`, seq, initiator: 'user',
  items: [
    { kind: 'message', id: `c1:turn:${seq}:message:question-${seq}`, seq: 0, role: 'user', text: `question ${seq}` },
    { kind: 'message', id: `c1:turn:${seq}:message:answer-${seq}`, seq: 1, role: 'assistant', text: `answer ${seq}` },
  ] });
const rows = () => fixture.sqlite.prepare('SELECT seq,data FROM session_turns ORDER BY seq').all();

/** The ingest child's own code, in process: the record read comes from `state.turns` (or real files via `realRead`). */
const fakeRead: typeof readRecordForIngest = async (input) => {
  if (!state.available) throw new SessionRecordNotFoundError('no record', []);
  if (input.locator.providerSessionId === 'parent') {
    return { status: 'complete', tail: [], committed: 0, tailFrom: 0, resumed: false, checkpoint: null, prunedDrops: 0, lineage: state.parentLineage };
  }
  const all = state.turns;
  const committed = (state.committed ?? state.turns).length;
  const settled = Math.max(0, committed - 1);
  input.onSettled(all.slice(0, settled), 0);
  state.read();
  return { status: 'complete', tail: all.slice(settled), committed: committed - settled, tailFrom: settled, resumed: false, checkpoint: null, prunedDrops: 0, lineage: null };
};
const realRead = () => state.read.mockImplementation(() => { throw new Error('real read'); });
let ingestDir = '';
/** The fill's result without the delivery ids it carries for resume (asserted on their own below). */
const sync = async (...args: Parameters<typeof syncStoredHistoryFromRecord>) => {
  const { deliveryIds: _ids, ...rest } = await syncStoredHistoryFromRecord(...args);
  return rest;
};

beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db;
  ingestDir = await mkdtemp(join(tmpdir(), 'record-ingest-'));
  state.requests = []; state.root = ''; state.parentLineage = null; state.read.mockReset();
  setRecordIngest({ dir: () => ingestDir, runner: async (request) => {
    state.requests.push(request);
    const useReal = state.root !== '';
    const run = await runIngest(request, useReal ? readRecordForIngest : fakeRead);
    return { summary: run.summary, next: run.next, dispose: async () => run.close() };
  } });
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p1','P','/repo'); INSERT INTO sessions(id,project_id,title,runtime,agent_status) VALUES ('c1','p1','C','pty','idle');");
  state.row = { runtime: 'pty', provider: 'codex', providerSessionId: 'record', agentStatus: 'idle', archivedAt: null, config: undefined };
  state.turns = [turn(0), turn(1)]; state.committed = null; state.process = null; state.tmux = false; state.available = true;
  state.pick.mockReset();
  vi.mocked(events.emit).mockClear();
});
afterEach(async () => { fixture.close(); setRecordIngest(null); await rm(ingestDir, { recursive: true, force: true }); });

it('stores completed history without outcome metadata, emits no live notification/activity/status facts, and is idempotent', async () => {
  const activity = vi.fn();
  const off = onActivitySignal(activity);
  const before = fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1');
  const unread = await nativeConversationUnread('c1');
  try {
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'complete' });
    expect(state.requests[0]).toMatchObject({ committedOnly: false });
    expect(rows()).toHaveLength(2);
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
    expect(rows()).toHaveLength(2);
    expect(await nativeConversationUnread('c1')).toEqual(unread);
    expect(fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1')).toEqual(before);
    expect(fixture.sqlite.prepare("SELECT key FROM kv WHERE key LIKE 'native-conversation-%'").all()).toEqual([]);
    expect(events.emit).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  } finally { off(); }
});

it('keeps an active suffix incomplete while persisting only the timeline-owned completed prefix', async () => {
  state.turns = [turn(0), turn(1)]; state.committed = [turn(0)]; state.row.agentStatus = 'working';
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'active' });
  expect(state.requests[0]).toMatchObject({ committedOnly: true });
  expect(rows()).toHaveLength(1);
  state.turns = [turn(0), turn(1)]; state.committed = null; state.row.agentStatus = 'idle';
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
  expect(state.requests[1]).toMatchObject({ committedOnly: false });
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
  state.row.provider = 'claude';
  state.root = root; realRead();
  const activity = vi.fn();
  const offActivity = onActivitySignal(activity);
  try {
    // Preserve/revise an actual early snapshot too: status notification can follow the record's prompt write.
    if (earlyPrompt) expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
    const before = rows();
    const sessionBefore = fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1');
    const unreadBefore = await nativeConversationUnread('c1');
    state.row.agentStatus = 'working';
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'active' });
    expect(rows()).toEqual(before);
    await appendFile(file, line('answer', 'assistant', 'SETTLEDREPLY'));
    state.row.agentStatus = 'idle';
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: earlyPrompt ? 0 : 1, status: 'complete' });
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
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
    expect(rows()).toEqual(stored);
  } finally {
    offActivity(); await rm(root, { recursive: true, force: true });
  }
});

it.each(['error', 'archived'])('keeps the unfinished last turn of a %s PTY without inventing an outcome', async kind => {
  state.row.agentStatus = kind === 'archived' ? 'working' : 'error';
  state.row.archivedAt = kind === 'archived' ? '2026-10-31' : null;
  state.committed = [turn(0)];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'complete' });
  expect(state.requests[0]).toMatchObject({ committedOnly: false });
  expect((rows() as { data: string }[]).map(row => JSON.parse(row.data).outcome)).toEqual([undefined, undefined]);
});

it('reports a live idle terminal whose last record turn has no outcome as settling, and final once its process is gone', async () => {
  state.process = { home: 'host', start: 'fresh' };
  state.turns = [{ ...turn(0), outcome: { kind: 'done', reason: 'end_turn' } }, turn(1)];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'settling' });
  state.turns = [state.turns[0], { ...turn(1), outcome: { kind: 'done', reason: 'end_turn' } }];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
  expect((rows() as { data: string }[]).map(row => JSON.parse(row.data).outcome?.kind)).toEqual(['done', 'done']);
  state.turns = [...state.turns, turn(2)]; state.process = null;
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
});

it('keeps a restarted terminal whose engine is still in tmux settling before reattach, and completes it when the turn lands', async () => {
  // After a host restart the process table is empty until reattach; tmux still holds the running engine.
  state.tmux = true;
  state.turns = [turn(0)];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'settling' });
  state.process = { home: 'host', start: 'fresh' };
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'settling' });
  state.turns = [{ ...turn(0), outcome: { kind: 'done', reason: 'end_turn' } }];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
  expect((rows() as { data: string }[]).map(row => JSON.parse(row.data).outcome?.kind)).toEqual(['done']);
});

it('uses the owned process fact when no status source exists', async () => {
  state.row.agentStatus = null; state.process = { home: 'host', start: 'fresh' };
  state.committed = [turn(0)];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'active' });
  expect(state.requests[0]).toMatchObject({ committedOnly: true });
});

it('does not append an idle snapshot suffix if a turn starts during the read', async () => {
  state.read.mockImplementationOnce(() => { state.row.agentStatus = 'working'; });
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'active' });
  expect(rows()).toEqual([]);
});

it('resumes after cancellation from committed canonical rows without repeating an earlier turn', async () => {
  // Cancel right after the first committed row: the row commit itself calls back (a test-only SQLite trigger).
  const abort = new AbortController();
  fixture.sqlite.function('abort_backfill', () => { abort.abort(); return null; });
  fixture.sqlite.exec('CREATE TEMP TRIGGER abort_after_first AFTER INSERT ON session_turns BEGIN SELECT abort_backfill(); END');
  try {
    expect(await sync('c1', { signal: abort.signal, runtime: 'pty' })).toEqual({ inserted: 1, status: 'cancelled' });
  } finally { fixture.sqlite.exec('DROP TRIGGER abort_after_first'); }
  expect(rows()).toHaveLength(1);
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
  expect(rows()).toHaveLength(2);
});

it('rechecks a presentation switch after waiting for the existing persistence queue', async () => {
  let release!: () => void;
  const prior = withStoredTurns('c1', () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const backfill = sync('c1', { runtime: 'pty' });
  state.row.runtime = 'acp'; release(); await prior;
  expect(await backfill).toEqual({ inserted: 0, status: 'runtime-changed' });
  expect(state.requests).toEqual([]);
  expect(rows()).toEqual([]);
});

it('reports missing, unsupported and divergent history without appending it', async () => {
  state.available = false;
  expect((await sync('c1', { runtime: 'pty' })).status).toBe('unavailable');
  state.available = true; state.row.provider = 'other';
  expect((await sync('c1', { runtime: 'pty' })).status).toBe('unsupported');
  state.row.provider = 'codex';
  await sync('c1', { runtime: 'pty' });
  state.turns = [{ ...turn(9), items: [{ kind: 'message', id: 'changed', seq: 0, role: 'user', text: 'different branch' }] }];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'diverged' });
  expect(rows()).toHaveLength(2);
});

it('does not write inherited history when the existing reader cannot prove the fork cut', async () => {
  state.row.config = { forkedFrom: { sessionId: 'parent' } };
  state.parentLineage = null;
  expect(await sync('c1', { runtime: 'pty' })).toMatchObject({ inserted: 0, status: 'diverged' });
  expect(state.requests[0].parent).toMatchObject({ sessionId: 'parent' });
  expect(rows()).toEqual([]);
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
  const source = (id: string, parentLineage?: readonly RecordLineageNode[] | null) =>
    createSessionRecordSource({ harness: 'claude', providerSessionId: id, roots: [root] }, { readMode: 'snapshot', parentLineage: parentLineage ?? undefined });
  const parent = await createSessionTimeline(source('parent'), { sessionId: 'parent' });
  const child = await createSessionTimeline(source('child', parent.getRecordLineage!()), { sessionId: 'c1' });
  try {
    state.row.provider = 'claude'; state.row.config = { forkedFrom: { sessionId: 'parent' } };
    state.row.providerSessionId = 'child'; state.root = root; realRead();
    expect(await sync('c1', { runtime: 'pty' })).toMatchObject({ inserted: 1, status: 'complete' });
    const stored = rows() as { seq: number; data: string }[];
    const texts = stored.flatMap(row => (JSON.parse(row.data) as TranscriptTurn).items.map(item => 'text' in item ? item.text : ''))
    expect(texts.join(' ')).not.toContain('parent');
    expect(texts.filter(text => text.startsWith('child'))).toHaveLength(2);
  } finally {
    child.dispose(); parent.dispose(); await rm(root, { recursive: true, force: true });
  }
});

it('carries every delivery id of the record, copied or not, and none when the record is missing', async () => {
  const delivered = (seq: number, id: string): TranscriptTurn => ({ ...turn(seq), items: [
    { kind: 'message', id: `c1:turn:${seq}:message:q-${seq}`, seq: 0, role: 'user', text: buildSystemNoticeEnvelope({ messageId: id, content: `hi ${seq}`, at: '2026-11-09T03:00:00Z' }) },
    { kind: 'message', id: `c1:turn:${seq}:message:a-${seq}`, seq: 1, role: 'assistant', text: `answer ${seq}` },
  ] });
  state.turns = [delivered(0, 'a1'), delivered(1, 'b1')];
  const first = await syncStoredHistoryFromRecord('c1', { runtime: 'pty' });
  expect(first).toMatchObject({ inserted: 2, status: 'complete' });
  expect(first.deliveryIds?.sort()).toEqual(['msg:a1', 'msg:b1']);
  // Already stored turns are not copied again; their deliveries are still the record's.
  expect((await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).deliveryIds?.sort()).toEqual(['msg:a1', 'msg:b1']);
  state.available = false;
  expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'unavailable' });
});

it('resumes from its checkpoint: appends terminal turns after the cursor, recognizes runtime-stored ones, keeps repeated prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-cursor-backfill-'));
  const fixtureFile = fileURLToPath(new URL('../../../../../../../packages/session-core/src/session-record/__fixtures__/codex-rollout.jsonl', import.meta.url));
  const lines = (await readFile(fixtureFile, 'utf8')).split('\n').filter(line => line.trim());
  const head = lines.filter(line => line.includes('"session_meta"'));
  const body = lines.filter(line => !line.includes('"session_meta"'));
  // Copies differ only in native ids: the same prompt and reply every time (the repeated-fingerprint case).
  const copy = (n: number) => body.map(line => line.replace(/"((?:msg|call|rs|fc)_)([A-Za-z0-9]+)"/g, (_all, p: string, r: string) => `"${p}c${n}${r}"`)
    .replace(/"([0-9a-f]{8})(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (_all, h: string, r: string) => `"${n.toString(16).padStart(2, '0')}${h.slice(2)}${r}"`));
  const file = join(root, '2026', '06', '18', 'rollout-2026-06-18T07-03-21-cursor-thread.jsonl');
  await mkdir(join(root, '2026', '06', '18'), { recursive: true });
  await writeFile(file, [...head, ...copy(0), ...copy(1)].join('\n') + '\n');
  state.row.providerSessionId = 'cursor-thread'; state.root = root; realRead();
  try {
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'complete' });
    expect(state.requests[0].checkpoint).toBeNull();
    // A turn only the terminal saw: appended, and read from the checkpoint, not from the start.
    await appendFile(file, copy(2).join('\n') + '\n');
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
    expect(state.requests[1].checkpoint).not.toBeNull();
    // A turn the runtime itself stored after the cursor (its own turn id): recognized, not appended again.
    await appendFile(file, copy(3).join('\n') + '\n');
    const timeline = await createSessionTimeline(createSessionRecordSource({ harness: 'codex', providerSessionId: 'cursor-thread', roots: [root] }), { sessionId: 'c1' });
    const live = timeline.getSnapshot({ limit: 100 }).turns.at(-1)!;
    timeline.dispose();
    fixture.sqlite.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,?,?,?,?)')
      .run('c1:3', 'c1', 3, 'c1:turn:9', JSON.stringify({ ...live, id: 'c1:turn:9', seq: 3 }));
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
    expect(state.requests[2].checkpoint).not.toBeNull();
    // No fill fell back to reading the record from its start.
    expect(state.requests).toHaveLength(3);
    expect(rows()).toHaveLength(4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('stores a copied picture as a file, keeps only its size and hash in the row, and reads it back', async () => {
  const picture = 'iVBORw0KGgo' + 'A'.repeat(4000);
  state.turns = [{ ...turn(0), items: [...turn(0).items,
    { kind: 'mcp-tool-call', id: 'c1:turn:0:tool:shot', seq: 2, toolCallId: 'shot', status: 'done', title: 'shot', server: 's', tool: 't',
      images: [{ mimeType: 'image/png', data: picture }] } as unknown as TranscriptTurn['items'][number]] }, turn(1)];
  expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'complete' });
  const stored = JSON.parse((rows() as { data: string }[])[0].data) as TranscriptTurn;
  const tool = stored.items.find(item => item.kind === 'mcp-tool-call') as unknown as { id: string; images?: unknown; imageRefs: unknown; storedImages: string[] };
  // The host never held the picture: the row has its size and hash, the bytes are in the ingest root.
  expect(tool.images).toBeUndefined();
  expect(tool.imageRefs).toEqual([{ mimeType: 'image/png', chars: picture.length }]);
  expect(tool.storedImages).toHaveLength(1);
  expect(await readFile(join(ingestDir, 'pictures', 'c1', tool.storedImages[0]), 'utf8')).toBe(picture);
  const { getStoredToolImage } = await import('./session-turn-store');
  expect(await getStoredToolImage({ sessionId: 'c1', seq: 0, itemId: tool.id, index: 0 }))
    .toEqual({ ok: true, image: { mimeType: 'image/png', data: picture } });
});

async function codexRecord(copies: number) {
  const root = await mkdtemp(join(tmpdir(), 'codex-cursor-fix-'));
  const fixtureFile = fileURLToPath(new URL('../../../../../../../packages/session-core/src/session-record/__fixtures__/codex-rollout.jsonl', import.meta.url));
  const lines = (await readFile(fixtureFile, 'utf8')).split('\n').filter(line => line.trim());
  const body = lines.filter(line => !line.includes('"session_meta"'));
  const copy = (n: number) => body.map(line => line.replace(/"((?:msg|call|rs|fc)_)([A-Za-z0-9]+)"/g, (_all, p: string, r: string) => `"${p}c${n}${r}"`)
    .replace(/"([0-9a-f]{8})(-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, (_all, h: string, r: string) => `"${n.toString(16).padStart(2, '0')}${h.slice(2)}${r}"`)
    .replace(/"(answer|turn)[^"]*"/g, (all) => all.slice(0, -1) + ` ${n}"`));
  const file = join(root, '2026', '06', '18', 'rollout-2026-06-18T07-03-21-fix-thread.jsonl');
  await mkdir(join(root, '2026', '06', '18'), { recursive: true });
  await writeFile(file, [...lines.filter(line => line.includes('"session_meta"')), ...Array.from({ length: copies }, (_, n) => copy(n)).flat()].join('\n') + '\n');
  state.row.providerSessionId = 'fix-thread'; state.root = root; realRead();
  return { root, file, copy };
}
const cursorRow = () => fixture.sqlite.prepare("SELECT value FROM kv WHERE key = 'record-ingest:c1'").get() as { value: string } | undefined;

it('drops the ingest cursor with the rows a revert removes, so the next fill reads from the start', async () => {
  const { root } = await codexRecord(3);
  try {
    expect(await sync('c1', { runtime: 'pty' })).toMatchObject({ status: 'complete' });
    expect(cursorRow()).toBeDefined();
    const { truncateStoredHistory } = await import('./session-turn-store');
    await truncateStoredHistory('c1', 1);
    expect(cursorRow()).toBeUndefined();
    await sync('c1', { runtime: 'pty' });
    expect(state.requests.at(-1)!.checkpoint).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('drops a checkpoint that fails to resume and reads the record from its start once', async () => {
  const { root, file, copy } = await codexRecord(2);
  try {
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'complete' });
    const before = JSON.parse(cursorRow()!.value) as { generation: number };
    await appendFile(file, copy(2).join('\n') + '\n');
    // The child dies on the checkpointed read (a crash, its heap limit): the next attempt has no checkpoint.
    setRecordIngest({ dir: () => ingestDir, runner: async (request) => {
      state.requests.push(request);
      if (request.checkpoint) throw new Error('worker exited');
      const run = await runIngest(request, readRecordForIngest);
      return { summary: run.summary, next: run.next, dispose: async () => run.close() };
    } });
    expect(await sync('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
    expect(state.requests.slice(-2).map(one => one.checkpoint === null)).toEqual([false, true]);
    expect(JSON.parse(cursorRow()!.value).generation).toBeGreaterThan(before.generation);
    expect(rows()).toHaveLength(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("still returns the record's deliveries when a fork cut cannot be proved", async () => {
  state.row.config = { forkedFrom: { sessionId: 'parent' } };
  state.parentLineage = null;
  state.turns = [{ ...turn(0), items: [{ kind: 'message', id: 'c1:turn:0:message:q', seq: 0, role: 'user',
    text: buildSystemNoticeEnvelope({ messageId: 'f1', content: 'hi', at: '2026-11-09T03:00:00Z' }) }] }];
  const result = await syncStoredHistoryFromRecord('c1', { runtime: 'pty' });
  expect(result).toMatchObject({ inserted: 0, status: 'diverged' });
  expect(result.deliveryIds).toEqual(['msg:f1']);
});

it('treats a damaged picture file as a picture that is gone', async () => {
  const picture = 'iVBORw0KGgo' + 'B'.repeat(4000);
  state.turns = [{ ...turn(0), items: [...turn(0).items,
    { kind: 'mcp-tool-call', id: 'c1:turn:0:tool:shot', seq: 2, toolCallId: 'shot', status: 'done', title: 'shot', server: 's', tool: 't',
      images: [{ mimeType: 'image/png', data: picture }] } as unknown as TranscriptTurn['items'][number]] }];
  await sync('c1', { runtime: 'pty' });
  const stored = JSON.parse((rows() as { data: string }[])[0].data) as TranscriptTurn;
  const tool = stored.items.find(item => item.kind === 'mcp-tool-call') as unknown as { id: string; storedImages: string[] };
  await writeFile(join(ingestDir, 'pictures', 'c1', tool.storedImages[0]), picture.slice(0, 100));
  const { getStoredToolImage } = await import('./session-turn-store');
  expect(await getStoredToolImage({ sessionId: 'c1', seq: 0, itemId: tool.id, index: 0 })).toMatchObject({ ok: false });
});
