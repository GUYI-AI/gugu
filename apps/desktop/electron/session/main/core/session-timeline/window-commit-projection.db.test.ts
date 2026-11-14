import { windowCommitProjectionDirectory } from './window-commit-projection-disk';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget, WINDOW_LIMITS } from '@gugu/session-core/session-record/window-cache/read-budget';
import * as disk from '@gugu/session-core/session-record/window-cache/disk-frame';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { advanceWindowCommitProjection as advance, readWindowCommitProjection as read } from './window-commit-projection';
import { readIndexedCommitContainerPage } from './window-commit-container-index';
import * as source from './window-commit-source';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('recoverable committed structural projection publication', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'commit-projection-'));
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });
  const turn = (text: string): TranscriptTurn => ({ id: 'runtime:0', seq: 0, referenceId: 'live-ref', initiator: 'user',
    items: [{ kind: 'message', id: 'runtime:0:item', seq: 0, role: 'assistant', text }],
    terminals: [{ terminalId: 'terminal', owner: 'agent', canKill: false, command: 'true', args: [], cwd: '/fixture', output: 'output', truncated: false, exitStatus: null }] });
  async function captured(text = 'actual 中文😀'.repeat(20000), sequence = 3) {
    if (sequence === 3) await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { ...turn('old'), id: 'old', referenceId: 'old-ref' } });
    await persistCommittedTurn({ sessionId: 'c', source: sequence === 3 ? 'live' : 'revision', turn: turn(text), windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence }, committed: async () => {} } });
    return createWindowCommitReceipts(fixture.sqlite).byReference('c', 'live-ref')!;
  }
  const context = (receipt: WindowCommitReceipt, buildId = 'version-a') => ({ directory, receipt, buildId, receipts: createWindowCommitReceipts(fixture.sqlite) });
  async function finish(c: ReturnType<typeof context>) {
    for (let i = 0; i < 300; i++) {
      const budget = createWindowBudget(), result = await advance(c, budget);
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536); expect(budget.counters.sourceBytes).toBe(0);
      if (result.kind === 'complete') return result; expect(result.kind).toBe('progress');
    }
    throw new Error('Projection did not complete');
  }
  const frame = (c: ReturnType<typeof context>, publication = false) => ({ ...c.receipt.binding,
    kind: publication ? 'projection' as const : 'head' as const, cursor: `commit-projection:${c.buildId}:${publication ? 'publication' : 'checkpoint'}` });

  it('resumes the committed non-first row from disk, publishes only after durable indices, and never parses its canonical data', async () => {
    const receipt = await captured(), c = context(receipt), original = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, ...args: unknown[]) => {
      if (text.includes('"items":[')) throw new Error('Full row parsing forbidden');
      return Reflect.apply(original, JSON, [text, ...args]) as unknown;
    }) as typeof JSON.parse);
    expect((await read(c, createWindowBudget())).kind).toBe('rebuild');
    for (let i = 0; i < 4; i++) expect((await advance(c, createWindowBudget())).kind).toBe('progress');
    expect((await read(c, createWindowBudget())).kind).toBe('rebuild');
    // A separate SQLite connection plus only persisted files supplies recovery;
    // no in-memory checkpoint/whole turn is passed to the resumed builder.
    const reopened = new Database(fixture.sqlite.name);
    try { await finish({ ...c, receipt: createWindowCommitReceipts(reopened).bySource(receipt.sourceId)!, receipts: createWindowCommitReceipts(reopened) }); }
    finally { reopened.close(); }
    const result = await read(c, createWindowBudget()); expect(result.kind).toBe('projection');
    if (result.kind !== 'projection') throw new Error('Missing projection');
    expect(result.root).toMatchObject({ turnId: 'c:turn:s1', storedSeq: 1, referenceId: 'live-ref' });
    const page = await readIndexedCommitContainerPage({ directory, binding: receipt.binding, source: receipt.source, index: result.itemsIndex }, 0, createWindowBudget());
    expect(page.kind).toBe('page'); expect(result.terminalsIndex?.kind).toBe('array');
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });

  it('keeps delivered version A byte-identical when revision B publishes, and accepts repeated publication only byte-for-byte', async () => {
    const a = context(await captured('old body')); await finish(a);
    const before = await disk.readWindowFrame(directory, frame(a, true), createWindowBudget());
    const b = context(await captured('new body', 4), 'version-b'); await finish(b);
    expect((await advance(a, createWindowBudget())).kind).toBe('complete');
    expect((await read(a, createWindowBudget())).kind).toBe('projection');
    const after = await disk.readWindowFrame(directory, frame(a, true), createWindowBudget()); expect(after).toEqual(before);
    expect((await read(b, createWindowBudget())).kind).toBe('projection');
  });

  it.each(['version', 'rootFacts'])('requests an anchored rebuild for corrupt checkpoint schema %s and preserves old publications', async bad => {
    const c = context(await captured('small')); await finish(c);
    const old = await disk.readWindowFrame(windowCommitProjectionDirectory(directory, c.receipt.binding), frame(c, true), createWindowBudget());
    const checkpoint = await disk.readWindowFrame(windowCommitProjectionDirectory(directory, c.receipt.binding), frame(c), createWindowBudget());
    if (checkpoint.kind !== 'hit') throw new Error('Missing checkpoint');
    const value = JSON.parse(Buffer.from(checkpoint.bytes).toString()) as { version: number; root: { facts: unknown } };
    if (bad === 'version') value.version = 2; else value.root.facts = null;
    await disk.writeWindowFrame(windowCommitProjectionDirectory(directory, c.receipt.binding), frame(c), Buffer.from(JSON.stringify(value)));
    expect(await advance(c, createWindowBudget())).toEqual({ kind: 'rebuild', anchor: { sourceId: c.receipt.sourceId, start: 0, end: c.receipt.source.bytes } });
    await finish({ ...c, buildId: 'recovered' });
    expect(await disk.readWindowFrame(windowCommitProjectionDirectory(directory, c.receipt.binding), frame(c, true), createWindowBudget())).toEqual(old);
  });

  it('propagates budget/I/O failures and cancellation without publishing success, and rejects uncommitted source claims before I/O', async () => {
    const c = context(await captured('small')), controller = new AbortController(); controller.abort();
    await expect(advance(c, createWindowBudget(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(advance({ ...c, receipts: { bySource: () => null } }, createWindowBudget())).rejects.toThrow('committed receipt');
    for (let i = 0; i < 100; i++) {
      const result = await advance(c, createWindowBudget());
      if (result.kind === 'progress' && result.stage === 'publish') break;
      if (i === 99) throw new Error('Build did not reach publication');
    }
    const original = disk.writeWindowFrame;
    const injected = vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      if (key.cursor.endsWith(':publication')) throw Object.assign(new Error('disk failed'), { code: 'EIO' });
      return original(dir, key, bytes);
    });
    await expect(advance(c, createWindowBudget())).rejects.toMatchObject({ code: 'EIO' }); injected.mockRestore();
    expect((await read(c, createWindowBudget())).kind).toBe('rebuild'); await finish(c);
    await expect(read(c, createWindowBudget({ ...WINDOW_LIMITS, indexBytes: 0 }))).rejects.toMatchObject({ name: 'WindowBudgetExceeded' });
  });

  it('does not return the newly written publication after physical source replacement during its final write', async () => {
    const c = context(await captured('small')), original = disk.writeWindowFrame;
    const injected = vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      await original(dir, key, bytes);
      if (key.cursor.endsWith(':publication')) await appendFile(join(directory,
        `${windowFrameName({ ...c.receipt.binding, kind: 'segment', cursor: 'raw:data' })}.source`), 'changed');
    });
    // Select this receipt's source even though the fixture also contains a legacy row.
    await expect(finish(c)).rejects.toThrow('source changed'); injected.mockRestore();
    await expect(read(c, createWindowBudget())).rejects.toThrow('source changed');
  });

  it.each(['publish', 'read'])('rechecks the transactional receipt after the final awaited source check during %s', async mode => {
    const c = context(await captured('small'));
    let finalCheck = 0;
    if (mode === 'read') {
      await finish(c);
      const counted = vi.spyOn(source, 'assertWindowCommitSource'); await read(c, createWindowBudget());
      finalCheck = counted.mock.calls.length; counted.mockRestore();
    } else for (let i = 0; i < 100; i++) {
      const result = await advance(c, createWindowBudget());
      if (result.kind === 'progress' && result.stage === 'publish') break;
      if (i === 99) throw new Error('Missing publish stage');
    }
    let published = false, checks = 0;
    const write = disk.writeWindowFrame, validate = source.assertWindowCommitSource;
    vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      await write(dir, key, bytes); if (key.cursor.endsWith(':publication')) published = true;
    });
    vi.spyOn(source, 'assertWindowCommitSource').mockImplementation(async (...args) => {
      await validate(...args); checks++;
      // Delete after the async proof helper's own synchronous check, before
      // its caller resumes. Only an adjacent check in the export closes this.
      if (mode === 'publish' ? published : checks === finalCheck) queueMicrotask(() => queueMicrotask(() => {
        fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(c.receipt.rowId);
      }));
    });
    await expect(mode === 'publish' ? advance(c, createWindowBudget()) : read(c, createWindowBudget())).rejects.toThrow('committed receipt');
    expect(createWindowCommitReceipts(fixture.sqlite).bySource(c.receipt.sourceId)).toBeNull();
  });
});
