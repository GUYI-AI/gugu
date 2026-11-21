import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mocks.userData } }));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider?: string) => provider === 'claude' ? 'claude' : null }));

const { exportStoredTurnsToJournals } = await import('./session-journal-export');

let sqlite: Database.Database;
const turn = (id: string, startedAt: number, outcome: TranscriptTurn['outcome']): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', startedAt, outcome, items: [{ kind: 'message', id: `${id}:message:u`, seq: 0, role: 'user', text: 'x' }],
} as TranscriptTurn);
const lines = async (sessionId: string) => (await readFile(join(mocks.userData, 'session-journal', `${sessionId}.jsonl`), 'utf8'))
  .trim().split('\n').map((line) => JSON.parse(line) as { id: string; recorded?: true });

beforeEach(async () => {
  mocks.userData = await mkdtemp(join(tmpdir(), 'journal-export-'));
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, provider TEXT);
    CREATE TABLE session_turns (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, turn_id TEXT, data TEXT);
    INSERT INTO sessions VALUES ('R', 'claude'), ('G', 'gemini');`);
  const insert = sqlite.prepare('INSERT INTO session_turns VALUES (?, ?, ?, ?, ?)');
  const row = (session: string, seq: number, turnId: string, data: TranscriptTurn) => insert.run(`${session}:${seq}`, session, seq, turnId, JSON.stringify(data));
  row('R', 0, 'R:turn:0', turn('R:turn:s0', 10, { kind: 'done' }));
  row('R', 1, 'R:turn:1', turn('R:turn:s1', 20, { kind: 'error', reason: 'process_closed' } as TranscriptTurn['outcome']));
  row('R', 2, 'owner-notify:n1', turn('owner-notify:n1', 30, { kind: 'done' }));
  row('G', 0, 'G:turn:0', turn('G:turn:s0', 10, { kind: 'done' }));
  row('G', 1, 'G:turn:1', turn('G:turn:s1', 20, { kind: 'done' }));
});
afterEach(async () => { sqlite.close(); await rm(mocks.userData, { recursive: true, force: true }); });

it('moves what only the turn table holds into the journals, once', async () => {
  await exportStoredTurnsToJournals(sqlite, mocks.userData);
  expect(await lines('R')).toEqual([
    expect.objectContaining({ id: 'R:turn:1@20', recorded: true }),
    expect.not.objectContaining({ recorded: true }),
  ]);
  expect((await lines('R'))[1]!.id).toBe('owner-notify:n1@30');
  expect((await lines('G')).map((line) => line.id)).toEqual(['G:turn:0@10', 'G:turn:1@20']);
  // Marked done: a later start does nothing, and a rerun after a crash adds nothing.
  await rm(join(mocks.userData, 'session-journal-export.done'));
  await exportStoredTurnsToJournals(sqlite, mocks.userData);
  expect((await lines('G')).map((line) => line.id)).toEqual(['G:turn:0@10', 'G:turn:1@20']);
});

it('throws on a row it cannot read and marks nothing done', async () => {
  sqlite.prepare("INSERT INTO session_turns VALUES ('G:9', 'G', 9, 'G:turn:9', 'not json')").run();
  await expect(exportStoredTurnsToJournals(sqlite, mocks.userData)).rejects.toThrow();
  await expect(readFile(join(mocks.userData, 'session-journal-export.done'))).rejects.toThrow();
});
