import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import * as disk from '@gugu/session-core/session-record/window-cache/disk-frame';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import * as source from './window-commit-source';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { advanceWindowCommitProjection, readWindowCommitProjection } from './window-commit-projection';
import { commitChildArray, commitEntityPublicationId, commitEntityPublicationKey, commitRootArray, openCommitEntity,
  readCommitEntityPublication } from './window-commit-entity';
import { publishCommitEntity } from './window-commit-entity-publication';
import { openCommitBodySlot, readCommitBodySlot } from './window-commit-slot';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('immutable canonical entity publication', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string;
  const huge = '真实 output 中文😀 \\ "\n'.repeat(10000);
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'commit-entity-publication-'));
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }); });
  async function captured() {
    const turn: TranscriptTurn = { id: 'runtime:0', seq: 0, referenceId: 'ref', initiator: 'user', items: [
      { kind: 'execute-tool-call', id: 'runtime:0:tool:actual', seq: 0, toolCallId: 'provider', title: 'Run', status: 'done',
        outputText: huge, rawOutput: '', rawInput: '{"command":"true"}', children: [
          { kind: 'mcp-tool-call', id: 'runtime:0:child', seq: 1, toolCallId: 'child-tool', tool: 'read', title: 'Read', status: 'done', rawOutput: 'actual child' }] }] };
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn, windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 3 }, committed: async () => {} } });
    const receipts = createWindowCommitReceipts(fixture.sqlite), receipt = receipts.byReference('c', 'ref')!;
    const c = { directory, receipts, receipt, buildId: 'root-version' };
    for (let i = 0; i < 300; i++) if ((await advanceWindowCommitProjection(c, createWindowBudget())).kind === 'complete') break;
    const root = await readWindowCommitProjection(c, createWindowBudget()); if (root.kind !== 'projection') throw new Error('Missing root');
    const selected = await openCommitEntity(directory, receipt, commitRootArray(root.root, 'item')!, root.itemsIndex, 0, 0, 'tool-version', createWindowBudget());
    if (selected.kind !== 'position') throw new Error('Missing actual entity');
    return { directory, receipts, receipt, rootBuildId: c.buildId, position: selected.position };
  }

  it('reopens real owner, child anchor and all three slot first pages without decoding the giant remainder', async () => {
    const c = await captured(), io: { indexBytes: number; sourceBytes: number }[] = [];
    const result = await publishCommitEntity({ ...c, observed(counters) { io.push({ ...counters }); } });
    expect(result.kind).toBe('published'); expect(Math.max(...io.map(c => c.indexBytes))).toBeLessThanOrEqual(65536);
    expect(io.every(c => c.sourceBytes === 0)).toBe(true);
    const reopened = await readCommitEntityPublication(directory, c.receipts, c.receipt, commitEntityPublicationId(c.position), createWindowBudget());
    if (reopened.kind !== 'entity') throw new Error('Missing durable entity');
    expect(reopened.facts).toMatchObject({ id: 'c:turn:s0:tool:actual', rowId: 'c:0', kind: 'execute-tool-call' });
    expect(commitChildArray(reopened.facts)).toMatchObject({ entity: 'item', turnId: reopened.facts.turnId });
    for (const field of ['outputText', 'rawOutput', 'rawInput']) {
      const slot = openCommitBodySlot(directory, c.receipts, c.receipt, reopened.facts, field, reopened.bodyBuildId);
      const first = await readCommitBodySlot(slot, 0, createWindowBudget()); if (first.kind !== 'body') throw new Error('Missing first body');
      expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(16384);
      if (field === 'outputText') {
        expect(first.text).toBe(huge.slice(0, first.text.length)); expect(first.moreAfter).toBe('yes');
        expect((await readCommitBodySlot(slot, first.nextOffset, createWindowBudget())).kind).toBe('rebuild');
      } else expect(first.text).toBe(field === 'rawOutput' ? '' : '{"command":"true"}');
    }
    await expect(readCommitEntityPublication(directory, c.receipts, c.receipt, 'bad-id', createWindowBudget())).rejects.toThrow('publication id');
  });
  it('does not publish before durable body completion and retries byte-identically after interruption', async () => {
    const c = await captured(), original = disk.writeWindowFrame;
    const interrupted = vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      if (key.kind === 'head' && key.cursor.startsWith('slot:')) throw Object.assign(new Error('body checkpoint failed'), { code: 'EIO' });
      await original(dir, key, bytes);
    });
    await expect(publishCommitEntity(c)).rejects.toMatchObject({ code: 'EIO' }); interrupted.mockRestore();
    const id = commitEntityPublicationId(c.position), key = commitEntityPublicationKey(c.receipt, id);
    expect(await disk.readWindowFrame(directory, key, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    expect(await publishCommitEntity(c)).toEqual({ kind: 'published', entityId: id });
    const saved = await disk.readWindowFrame(directory, key, createWindowBudget()); if (saved.kind !== 'hit') throw new Error('Missing publication');
    expect(await publishCommitEntity(c)).toEqual({ kind: 'published', entityId: id });
    expect(await disk.readWindowFrame(directory, key, createWindowBudget())).toEqual(saved);
    await rm(join(directory, windowFrameName(key))); await disk.writeWindowFrame(directory, key, Buffer.from('{"version":0}'));
    expect((await readCommitEntityPublication(directory, c.receipts, c.receipt, id, createWindowBudget())).kind).toBe('rebuild');
    await expect(publishCommitEntity(c)).rejects.toThrow('Conflicting immutable entity');
  });
  it('retains no success after final receipt deletion and isolates throwing metrics/diagnostics', async () => {
    const c = await captured(), observed = vi.fn(() => { throw new Error('metrics failed'); });
    expect((await publishCommitEntity({ ...c, observed, report() { throw new Error('diagnostic failed'); } })).kind).toBe('published');
    expect(observed).toHaveBeenCalled();
    const validate = source.assertWindowCommitSource;
    vi.spyOn(source, 'assertWindowCommitSource').mockImplementation(async (...args) => {
      await validate(...args); queueMicrotask(() => queueMicrotask(() => fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(c.receipt.rowId)));
    });
    await expect(readCommitEntityPublication(directory, c.receipts, c.receipt, commitEntityPublicationId(c.position), createWindowBudget())).rejects.toThrow('receipt');
  });
  it('cancels before starting or immediately after the publication write without returning a successful id', async () => {
    const c = await captured(), abort = new AbortController(); abort.abort();
    await expect(publishCommitEntity(c, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const late = new AbortController(), original = disk.writeWindowFrame;
    vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      await original(dir, key, bytes); if (key.cursor.startsWith('entity:')) late.abort();
    });
    await expect(publishCommitEntity(c, late.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('refuses publication success when canonical deletion happens after the immutable entity write', async () => {
    const c = await captured(), original = disk.writeWindowFrame;
    vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      await original(dir, key, bytes);
      if (key.cursor.startsWith('entity:')) fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(c.receipt.rowId);
    });
    await expect(publishCommitEntity(c)).rejects.toThrow('committed source');
  });
});
