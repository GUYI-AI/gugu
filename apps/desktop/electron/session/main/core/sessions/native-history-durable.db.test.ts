import { openFixture } from '@tooling/utils/db';
import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { compareWrites, measureWrites, quantiles } from '../../../../../../../scripts/perf/native-history-durable.mjs';
import { checkCompatibility } from '../../../../../../../scripts/perf/native-history-compat.mjs';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw Error('No fixture'); return state.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from './session-turn-store';

it.each(['insert', 'revision'] as const)('validates real canonical %s writes on a FULL/WAL disk database', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-c-durable-'));
  const fixture = await openFixture('empty');
  state.db = fixture.db;
  fixture.sqlite.pragma('synchronous = FULL');
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','bench','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
  if (scenario === 'revision') await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: {
    id: 'runtime:stable', seq: 0, initiator: 'user', items: [{ kind: 'message', id: 'stable:m', seq: 0, role: 'user', text: 'seed' }],
  } as TranscriptTurn });
  let closed = false;
  try {
    const result = await measureWrites({ directory: join(root, 'before'), mode: 'before', count: 8, warmup: 2, payloadBytes: 1024,
      expectedCanonicalRows: scenario === 'revision' ? 1 : 10,
      adapter: { async open() { return {
        async metadata() { return { sourceSha: process.env.GUGU_BENCH_SOURCE_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), writerEntry: 'session-turn-store.ts:persistCommittedTurn',
          databasePath: fixture.sqlite.name, additionsEnabled: false,
          sqlite: { journalMode: String(fixture.sqlite.pragma('journal_mode', { simple: true })), synchronous: Number(fixture.sqlite.pragma('synchronous', { simple: true })),
            fullfsync: Number(fixture.sqlite.pragma('fullfsync', { simple: true })), walAutocheckpoint: Number(fixture.sqlite.pragma('wal_autocheckpoint', { simple: true })) } }; },
        async commit(input: { index: number; text: string }, mark: (phase: string) => void) {
          const id = scenario === 'revision' ? 'runtime:stable' : `runtime:${input.index}`;
          const turn = { id, seq: input.index + 2, initiator: 'user', items: [{ kind: 'message', id: `${id}:m`, seq: 0, role: 'user', text: `${input.index}:${input.text}` }] } as TranscriptTurn;
          await persistCommittedTurn({ sessionId: 'c', source: scenario === 'revision' ? 'revision' : 'live', turn });
          mark('canonical_committed');
        },
        async identity(input: { index: number }) {
          const row = fixture.sqlite.prepare('SELECT id FROM session_turns WHERE turn_id=?').get(scenario === 'revision' ? 'runtime:stable' : `runtime:${input.index}`) as { id: string };
          return { rowId: row.id };
        },
        async verify() {
          const reopened = new Database(fixture.sqlite.name);
          try {
            const last = reopened.prepare('SELECT data FROM session_turns WHERE turn_id=?').get(scenario === 'revision' ? 'runtime:stable' : 'runtime:7') as { data: string };
            expect(JSON.parse(last.data).items[0].text).toBe(`7:${'x'.repeat(1024)}`);
            return { canonicalRows: (reopened.prepare('SELECT count(*) n FROM session_turns').get() as { n: number }).n };
          }
          finally { reopened.close(); }
        },
        async close() { fixture.close(); closed = true; },
      }; } } });
    expect(result.summary.latency.n).toBe(8);
    expect(result.samples.every(sample => sample.phases[0].name === 'canonical_committed')).toBe(true);
    expect((await readFile(join(root, 'before/writes.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(10);
    if (process.env.GUGU_BENCH_REPORT) await writeFile(`${process.env.GUGU_BENCH_REPORT}.${scenario}.json`, JSON.stringify(result, null, 2));
    expect(quantiles([1, 2, 3, 4, 5])).toEqual({ n: 5, p50Ms: 3, p95Ms: 5, maxMs: 5 });
  } finally {
    if (!closed) fixture.close();
    state.db = undefined;
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects nonfinite samples and reports nearest-rank p50/p95 without hiding regressions', () => {
  expect(() => quantiles([1, NaN])).toThrow();
  expect(() => quantiles([])).toThrow();
  const make = (mode: string, values: number[], synchronous = 2) => ({
    summary: { mode, payloadBytes: 1024, count: values.length, warmup: 2, expectedCanonicalRows: values.length,
      meta: { sqlite: { journalMode: 'wal', synchronous } }, latency: quantiles(values) },
    samples: values.map((elapsedMs, index) => ({ index, elapsedMs })),
  });
  const before = make('before', [1, 2, 3, 4]);
  const after = make('after', [2, 4, 6, 8]);
  expect(compareWrites(before, after)).toMatchObject({ p50DifferenceMs: 2, p95DifferenceMs: 4, pairedDeltaP95Ms: 4 });
  expect(() => compareWrites(before, make('after', [2, 4, 6, 8], 1))).toThrow('SQLite fsync configuration differs');
  expect(() => compareWrites(before, { ...after, summary: { ...after.summary, expectedCanonicalRows: 1 } })).toThrow();
});

it('refuses to count a real disk write without receipts/projections as a completed after path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-c-partial-method-'));
  const file = join(root, 'partial.db');
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode=WAL'); sqlite.pragma('synchronous=FULL');
  sqlite.exec('CREATE TABLE sample(id TEXT PRIMARY KEY)');
  const adapter = { async open() { return {
    async metadata() { return { sourceSha: 'a'.repeat(40), writerEntry: 'negative-contract-fixture', databasePath: file,
      additionsEnabled: true, sqlite: { journalMode: 'wal', synchronous: 2 } }; },
    async commit() { sqlite.prepare('INSERT INTO sample VALUES(?)').run('real-write'); return { rowId: 'real-write' }; },
    async verify() { throw Error('Partial adapter must not reach verification'); },
    async close() { sqlite.close(); },
  }; } };
  try {
    await expect(measureWrites({ adapter, directory: join(root, 'after'), mode: 'after', count: 1, warmup: 0, payloadBytes: 1 }))
      .rejects.toThrow('Full durable path is not connected');
    expect(await readFile(join(root, 'after/writes.jsonl'), 'utf8')).toContain('Full durable path is not connected');
  } finally { if (sqlite.open) sqlite.close(); await rm(root, { recursive: true, force: true }); }
});

it.each(['canonical', 'projection', 'source', 'identity', 'none'])('checks compatibility receipt binding after %s disk mutation', async mutation => {
  // Negative protocol fixture only: this does not execute or certify the old application/schema.
  const root = await mkdtemp(join(tmpdir(), 'gugu-c-compat-negative-'));
  const step = async (file: string, sql: string) => {
    const db = new Database(file);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, source TEXT, projection TEXT)');
      db.exec(sql);
      const rows = db.prepare('SELECT id,data FROM rows ORDER BY id').all() as { id: string; data: string }[];
      const receipts = db.prepare('SELECT id,source,projection FROM receipts ORDER BY id').all() as { id: string; source: string; projection: string }[];
      return { rows: rows.map(row => ({ id: row.id, sha256: createHash('sha256').update(row.data).digest('hex') })),
        integrity: String(db.pragma('integrity_check', { simple: true })), foreignKeyErrors: db.pragma('foreign_key_check') as unknown[],
        newReceiptRows: receipts.length, newReceipts: receipts.map(({ id, source, projection }) => ({ id,
          sha256: createHash('sha256').update(JSON.stringify([source, projection])).digest('hex') })) };
    } finally { db.close(); }
  };
  try {
    const corrupt = { canonical: "UPDATE rows SET data='corrupt' WHERE id='a';", projection: "UPDATE receipts SET projection='wrong-source';",
      source: "UPDATE receipts SET source='wrong-source';", identity: "UPDATE receipts SET id='replacement';", none: '' }[mutation];
    const run = checkCompatibility({
      async metadata() { return { oldSha: 'cb2ba40311b40904aea33786008cf82e42467eeb', newSha: 'a'.repeat(40),
        level: 'source-schema' as const, oldInitializer: 'negative-contract-fixture', newInitializer: 'negative-contract-fixture' }; },
      seedOld: file => step(file, "INSERT INTO rows VALUES('a','keep')"),
      upgradeAndWriteNew: file => step(file, "INSERT INTO rows VALUES('b','new'); INSERT INTO receipts VALUES('b','physical-source','projection-frame')"),
      openOldAndWrite: file => step(file, `${corrupt} INSERT INTO rows VALUES('c','old-write')`),
      reopenNew: file => step(file, ''),
    }, join(root, 'case'));
    const message = mutation === 'canonical' ? 'Lost/changed canonical row a' : 'Lost/changed receipt b';
    if (mutation === 'none') await expect(run).resolves.toMatchObject({ passed: true });
    else await expect(run).rejects.toThrow(message);
    const raw = JSON.parse(await readFile(join(root, 'case/compat-raw.json'), 'utf8'));
    expect(raw.stages).toHaveLength(mutation === 'none' ? 4 : 3);
    expect(raw.stages[2].snapshot.rows).toHaveLength(3);
    if (mutation !== 'none') expect(await readFile(join(root, 'case/compat-failed.json'), 'utf8')).toContain(message);
  } finally { await rm(root, { recursive: true, force: true }); }
});
