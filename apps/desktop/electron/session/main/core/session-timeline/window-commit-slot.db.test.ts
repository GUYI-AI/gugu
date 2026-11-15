import { windowCommitProjectionDirectory } from './window-commit-projection-disk';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget, WINDOW_LIMITS } from '@gugu/session-core/session-record/window-cache/read-budget';
import * as disk from '@gugu/session-core/session-record/window-cache/disk-frame';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import * as source from './window-commit-source';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { advanceWindowCommitProjection, readWindowCommitProjection } from './window-commit-projection';
import { advanceCommitContainerIndex } from './window-commit-container-index';
import { advanceCommitEntityFields, commitEntityIndex, commitRootArray, createCommitEntityState, openCommitEntity } from './window-commit-entity';
import { advanceCommitBodySlot as advance, openCommitBodySlot, readCommitBodySlot as read } from './window-commit-slot';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('durable exact canonical body slot pages', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string;
  const text = 'actual 中文😀 \\ "\n'.repeat(10000);
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'commit-slot-'));
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });
  async function captured(body = text) {
    const turn: TranscriptTurn = { id: 'runtime:0', seq: 0, referenceId: 'live-ref', initiator: 'user', items: [
      Object.assign({ kind: 'message' as const, id: 'runtime:0:item', seq: 0, role: 'assistant' as const, text: body }, { rawOutput: 'not the message slot' })] };
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { ...turn, id: 'old', referenceId: 'old-ref', items: [] } });
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn, windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 3 }, committed: async () => {} } });
    const receipts = createWindowCommitReceipts(fixture.sqlite), receipt = receipts.byReference('c', 'live-ref')!;
    const c = { directory, receipts, receipt, buildId: 'version-a' };
    for (let i = 0; i < 300; i++) if ((await advanceWindowCommitProjection(c, createWindowBudget())).kind === 'complete') break;
    const projected = await readWindowCommitProjection(c, createWindowBudget()); if (projected.kind !== 'projection') throw new Error('Missing structural version');
    const opened = await openCommitEntity(directory, receipt, commitRootArray(projected.root, 'item')!, projected.itemsIndex, 0, 0, 'entity', createWindowBudget());
    if (opened.kind !== 'position') throw new Error('Missing entity');
    const index = commitEntityIndex(opened.position);
    for (let i = 0; i < 300; i++) if ((await advanceCommitContainerIndex({ directory, binding: receipt.binding, source: receipt.source, index }, createWindowBudget())).kind === 'complete') break;
    let cursor = createCommitEntityState(opened.position);
    for (let i = 0; i < 100; i++) {
      const result = await advanceCommitEntityFields(opened.position, cursor, createWindowBudget());
      if (result.kind === 'complete') return { receipt, facts: result.facts, receipts, slot: openCommitBodySlot(directory, receipts, receipt, result.facts, 'text', 'body-version') };
      if (result.kind !== 'progress') throw new Error('Missing entity facts'); cursor = result.state;
    }
    throw new Error('Entity did not finish');
  }
  async function complete(slot: Awaited<ReturnType<typeof captured>>['slot']) {
    for (let i = 0; i < 100; i++) {
      const budget = createWindowBudget(), result = await advance(slot, budget);
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536); expect(budget.counters.sourceBytes).toBe(0);
      if (result.kind === 'complete') return; expect(result.kind).toBe('progress');
    }
    throw new Error('Body did not finish');
  }

  it('restores a late page and its previous/next boundaries by point lookup after discarding page-local state', async () => {
    const f = await captured(); await complete(f.slot);
    let offset = 0, resultText = '', previous: number | null = null, pages = 0;
    for (;;) {
      const budget = createWindowBudget(), page = await read(f.slot, offset, budget);
      if (page.kind !== 'body') throw new Error('Missing body page');
      expect(page.previousOffset).toBe(previous); expect(budget.counters.indexBytes).toBeLessThan(20000);
      resultText += page.text; pages++;
      if (page.moreAfter === 'no') break;
      previous = offset; offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(5); expect(resultText).toBe(text);
    const rebuilt = openCommitBodySlot(directory, f.receipts, f.receipt, f.facts, 'text', 'body-version');
    const late = await read(rebuilt, offset, createWindowBudget()); expect(late.kind).toBe('body');
    if (late.kind !== 'body') throw new Error('Missing late page');
    const prior = await read(rebuilt, late.previousOffset!, createWindowBudget());
    expect(prior).toMatchObject({ kind: 'body', nextOffset: offset });
  });
  it('persists an empty genuine slot and refuses foreign/copied owner proofs and unsupported message fields', async () => {
    const f = await captured(''); await complete(f.slot);
    expect(await read(f.slot, 0, createWindowBudget())).toMatchObject({ kind: 'body', text: '', nextOffset: 0, moreAfter: 'no' });
    expect(() => openCommitBodySlot(directory, f.receipts, f.receipt, { ...f.facts }, 'text', 'other')).toThrow('owner/slot');
    expect(() => openCommitBodySlot(directory, f.receipts, f.receipt, f.facts, 'rawOutput', 'other')).toThrow('owner/slot');
    await expect(read({ ...f.slot }, 0, createWindowBudget())).rejects.toThrow('Unknown');
  });
  it('resumes identical durable content/descriptor after a failed checkpoint write within one read budget', async () => {
    const f = await captured(), original = disk.writeWindowFrame;
    const interrupted = vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      if (key.cursor.startsWith('slot:') && key.kind === 'head') throw Object.assign(new Error('checkpoint failed'), { code: 'EIO' });
      await original(dir, key, bytes);
    });
    await expect(advance(f.slot, createWindowBudget())).rejects.toMatchObject({ code: 'EIO' }); interrupted.mockRestore();
    const bodyKey = { ...f.receipt.binding, kind: 'body' as const, cursor: `slot:${f.slot.id}:body:0` };
    const prior = await disk.readWindowFrame(windowCommitProjectionDirectory(directory, bodyKey), bodyKey, createWindowBudget()); if (prior.kind !== 'hit') throw new Error('Missing durable content');
    await rm(join(windowCommitProjectionDirectory(directory, bodyKey), windowFrameName(bodyKey))); await disk.writeWindowFrame(windowCommitProjectionDirectory(directory, bodyKey), bodyKey, Buffer.from('conflicting content'));
    await expect(advance(f.slot, createWindowBudget())).rejects.toThrow('Conflicting immutable');
    await rm(join(windowCommitProjectionDirectory(directory, bodyKey), windowFrameName(bodyKey))); await disk.writeWindowFrame(windowCommitProjectionDirectory(directory, bodyKey), bodyKey, prior.bytes);
    const budget = createWindowBudget(); expect((await advance(f.slot, budget)).kind).toBe('progress');
    expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
    const first = await read(f.slot, 0, createWindowBudget()); expect(first).toMatchObject({ kind: 'body' });
    if (first.kind === 'body') expect(first.text).toBe(text.slice(0, first.text.length));
  });
  it('honors cancellation/admission and checks receipt deletion after its final asynchronous physical check', async () => {
    const f = await captured('small'), abort = new AbortController(); abort.abort();
    await expect(advance(f.slot, createWindowBudget(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await complete(f.slot);
    await expect(read(f.slot, 0, createWindowBudget({ ...WINDOW_LIMITS, indexBytes: 0 }))).rejects.toMatchObject({ name: 'WindowBudgetExceeded' });
    const validate = source.assertWindowCommitSource;
    vi.spyOn(source, 'assertWindowCommitSource').mockImplementation(async (...args) => {
      await validate(...args); queueMicrotask(() => queueMicrotask(() => fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(f.receipt.rowId)));
    });
    await expect(read(f.slot, 0, createWindowBudget())).rejects.toThrow('committed receipt');
  });
});
