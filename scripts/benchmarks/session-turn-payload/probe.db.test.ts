import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, openSync, writeSync, closeSync, statSync, existsSync, rmSync, statfsSync } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { AppDb } from '@main/db/client';
import { openPhysicalDatabase } from '@main/db/physical-connection';
import { initializeDatabase } from '@main/db/initialize';
import * as schema from '@main/db/schema';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { payloadConversation } from './fixture';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { assert(state.db); return state.db; }, get sqlite() { assert(state.sqlite); return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn, readStoredTurns } from '@main/core/sessions/session-turn-store';
import { createWindowCommitReceipts, type WindowCommitReceipt } from '@main/core/session-timeline/window-commit-receipt';
import { readWindowCommitSourceChunk } from '@main/core/session-timeline/window-commit-source';

type Trace = { start(roots: string[]): void; stop(): { writtenBytes: number; readBytes: number; writeCalls: number; readCalls: number; syncCalls: number } };
const trace = (globalThis as typeof globalThis & { __turnPayloadIo: Trace }).__turnPayloadIo;
const size = (path: string) => existsSync(path) ? statSync(path).size : 0;
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('isolated real session writer benchmark', () => {
  it('records all phases and verifies current and previous history after reopening', async () => {
    const requested = process.env.GUGU_TURN_BENCH_ROOT, sourceSha = process.env.GUGU_TURN_BENCH_SHA, mode = process.env.GUGU_TURN_BENCH_MODE;
    assert(requested && sourceSha && ['before', 'after'].includes(mode ?? '') && trace, 'Explicit isolated benchmark configuration and preload required');
    assert.match(sourceSha, /^[a-f0-9]{40}$/);
    const root = resolve(requested);
    assert(process.env.GUGU_HOME && process.env.GUGU_USER_DATA_DIR && process.env.GUGU_HOME !== process.env.GUGU_USER_DATA_DIR);
    assert(!existsSync(root), 'Evidence directories must never be reused');
    const disk = statfsSync(resolve(root, '..')); assert(disk.bavail * disk.bsize >= 16 * 1024 ** 3);
    mkdirSync(root, { recursive: false, mode: 0o700 });
    const sourceDirectory = join(root, 'window'); await mkdir(sourceDirectory);
    // Prove the tracer on the exact sync and FileHandle routes used by the writer.
    const self = join(root, 'tracer-check'); trace.start([root]);
    writeFileSync(self, Buffer.alloc(3));
    const fd = openSync(self, 'a'); writeSync(fd, Buffer.alloc(5)); writeFileSync(fd, Buffer.alloc(13)); closeSync(fd);
    const handle = await open(self, 'a'); await handle.write(Buffer.alloc(7)); await handle.writeFile(Buffer.alloc(11)); await handle.close();
    assert.equal(trace.stop().writtenBytes, 39); rmSync(self);
    const originals = payloadConversation(), expected = originals.map(turn => ({ ...turn }));
    const fixture = { images: { occurrences: 119, unique: 73, inlineBytes: 47244868, uniqueInlineBytes: 29165512 },
      execute: { count: 1277, outputTextBytes: 10688334 }, digest: sha(originals), revisionsPerTurn: 3 };
    const database = join(root, 'bench.db');
    let connection = openPhysicalDatabase(database);
    connection.pragma('journal_mode=WAL'); connection.pragma('synchronous=FULL'); connection.pragma('wal_autocheckpoint=0');
    await initializeDatabase(connection);
    state.sqlite = connection; state.db = Object.assign(drizzle(connection, { schema }), { connection });
    connection.exec("INSERT INTO projects(id,name,path) VALUES('bench-project','Synthetic','/synthetic'); INSERT INTO sessions(id,project_id) VALUES('bench','bench-project')");
    connection.pragma('wal_checkpoint(TRUNCATE)');
    const samples: unknown[] = [], receipts: Array<{ receipt: WindowCommitReceipt; digest: string }> = [];
    let sequence = 0;
    async function commit(turn: TranscriptTurn, source: 'live' | 'revision') {
      const priorWal = size(`${database}-wal`), phases: Array<{ name: string; ms: number }> = [];
      trace.start([root]);
      const started = performance.now();
      let captured: WindowCommitReceipt | null = null;
      try {
        await persistCommittedTurn({ sessionId: 'bench', source, turn, windowCapture: {
          directory: sourceDirectory, scope: 'b'.repeat(64), cursor: { workerEpoch: 'benchmark', storeEpoch: 'benchmark', sequence: ++sequence },
          phase(name) { phases.push({ name, ms: performance.now() - started }); },
          async committed(receipt) { captured = receipt; },
        } });
      } catch (error) {
        const measured = trace.stop();
        writeFileSync(join(root, 'failure.json'), JSON.stringify({ sourceSha, mode, fixture, samples, source, sequence, phases, measured, error: String(error) }, null, 2));
        throw error;
      }
      const elapsedMs = performance.now() - started, nodeIo = trace.stop(), walBytes = size(`${database}-wal`) - priorWal;
      assert(walBytes >= 0 && captured);
      assert.deepEqual(phases.map(phase => phase.name), ['source_durable', 'canonical_committed']);
      samples.push({ sequence, source, turn: turn.referenceId, elapsedMs, phases, walBytes, nodeIo, totalWrittenBytes: walBytes + nodeIo.writtenBytes });
      receipts.push({ receipt: captured, digest: sha(turn) });
    }
    try {
      for (const turn of originals) await commit(turn, 'live');
      for (let revision = 0; revision < 3; revision++) for (let index = 0; index < expected.length; index++) {
        expected[index] = { ...expected[index], endedAt: 50 + revision, outcome: revision % 2 ? { kind: 'done' } : { kind: 'error', reason: 'process_closed' } };
        await commit(expected[index], 'revision');
      }
      assert.deepEqual((await readStoredTurns('bench', { fromSeq: 0 })).turns, expected);
      const sqliteSettings = { journalMode: connection.pragma('journal_mode', { simple: true }), synchronous: connection.pragma('synchronous', { simple: true }),
        walAutocheckpoint: connection.pragma('wal_autocheckpoint', { simple: true }), pageSize: connection.pragma('page_size', { simple: true }) };
      assert.equal(connection.pragma('integrity_check', { simple: true }), 'ok');
      connection.close();
      connection = openPhysicalDatabase(database); state.sqlite = connection; state.db = Object.assign(drizzle(connection, { schema }), { connection });
      assert.deepEqual((await readStoredTurns('bench', { fromSeq: 0 })).turns, expected);
      // Each captured snapshot must survive subsequent revisions and a database reopen.
      for (const entry of receipts) {
        assert.equal(createWindowCommitReceipts(connection).bySource(entry.receipt.sourceId)?.sourceId, entry.receipt.sourceId);
        const hash = createHash('sha256');
        for (let ordinal = 0; ordinal < entry.receipt.source.chunks; ordinal++) hash.update(await readWindowCommitSourceChunk(
          sourceDirectory, entry.receipt.binding, entry.receipt.source, ordinal, createWindowBudget()));
        assert.equal(hash.digest('hex'), entry.digest);
      }
      await writeFile(join(root, 'result.json'), JSON.stringify({ sourceSha, mode, node: process.version, fixture, sqliteSettings, samples,
        verification: { reopened: true, historyEqual: true, priorSnapshots: receipts.length, integrityCheck: 'ok' } }, null, 2), { flag: 'wx' });
    } finally { connection.close(); state.sqlite = undefined; state.db = undefined; }
  }, 240_000);
});
