import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { advanceCommitContainerIndex, type CommitContainerIndex } from './window-commit-container-index';
import { advanceCommitRootFields as advance, advanceCommitRootBatch, createCommitRootState as create, type CommitRootState } from './window-commit-root';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('canonical root fields from actual writer source', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'commit-root-'));
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; if (directory) await rm(directory, { recursive: true, force: true }); });
  async function captured(items: TranscriptTurn['items'] = [{ kind: 'message', id: 'runtime:0:item', seq: 0, role: 'assistant', text: 'runtime:0 remains body text 😀'.repeat(10000) }]) {
    const turn: TranscriptTurn = { id: 'runtime:0', seq: 0, referenceId: 'live-ref', initiator: 'user', items, outcome: { kind: 'done' } };
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { ...turn, id: 'old', referenceId: 'old-ref', items: [] } });
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn, windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 3 }, committed: async () => {} } });
    const receipt = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'live-ref')!;
    const index: CommitContainerIndex = { buildId: 'root-build', kind: 'object', range: { start: 0, end: receipt.source.bytes } };
    for (let n = 0; n < 200; n++) {
      const result = await advanceCommitContainerIndex({ directory, binding: receipt.binding, source: receipt.source, index }, createWindowBudget());
      if (result.kind === 'complete') return { receipt, index };
      expect(result.kind).toBe('progress');
    }
    throw new Error('Root index did not complete');
  }
  async function fields(receipt: WindowCommitReceipt, index: CommitContainerIndex) {
    let cursor = create(receipt, index);
    for (let n = 0; n < 100; n++) {
      const original = JSON.stringify(cursor), budget = createWindowBudget();
      const result = await advance(directory, receipt, index, cursor, budget);
      expect(JSON.stringify(cursor)).toBe(original);
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536); expect(budget.counters.sourceBytes).toBe(0);
      if (result.kind === 'complete') return result;
      if (result.kind !== 'progress') throw new Error(`Unexpected root result ${result.kind}`);
      expect(JSON.stringify(result.state).length).toBeLessThan(4096);
      cursor = JSON.parse(JSON.stringify(result.state)) as CommitRootState;
    }
    throw new Error('Root fields did not complete');
  }

  it('reads the actual non-first stored identity/items without parsing the canonical data column or holding the body', async () => {
    const { receipt, index } = await captured(), original = JSON.parse;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, ...args: unknown[]) => {
      if (text.includes('"items":[')) throw new Error('Full canonical row parsing forbidden');
      return Reflect.apply(original, JSON, [text, ...args]) as unknown;
    }) as typeof JSON.parse);
    const result = await fields(receipt, index);
    expect(receipt.rowId).toBe('c:1'); expect(result.facts).toMatchObject({ turnId: 'c:turn:s1', storedSeq: 1, referenceId: 'live-ref' });
    expect(result.facts.turnId).not.toBe('runtime:0'); expect(result.facts.items.start).toBeGreaterThan(0);
    expect(result.facts.items.end - result.facts.items.start).toBeGreaterThan(200000);
    expect(JSON.stringify(result.facts).length).toBeLessThan(512);
  });

  it.each(['referenceId', 'storedSeq'] as const)('rejects a source/receipt %s mismatch', async field => {
    const { receipt, index } = await captured([]);
    const wrong = { ...receipt, ...(field === 'referenceId' ? { referenceId: 'wrong-ref' } : { storedSeq: 2 }) };
    await expect(fields(wrong, index)).rejects.toThrow(field === 'referenceId' ? 'reference mismatch' : 'sequence mismatch');
  });

  it('keeps an actual empty items array and refuses a child range masquerading as the root or a foreign checkpoint', async () => {
    const { receipt, index } = await captured([]), result = await fields(receipt, index);
    expect(result.facts.items.end - result.facts.items.start).toBe(2);
    expect(() => create(receipt, { ...index, range: result.facts.items })).toThrow('root range');
    const budget = createWindowBudget();
    await expect(advance(directory, receipt, index, { ...create(receipt, index), sourceId: 'foreign' }, budget)).rejects.toThrow('checkpoint');
    expect(budget.counters.indexBytes).toBe(0);
  });

  it('snapshots the root index before I/O and honors cancellation without advancing the caller checkpoint', async () => {
    const { receipt, index } = await captured([]), initial = create(receipt, index), saved = JSON.stringify(index);
    const pending = advance(directory, receipt, index, initial, createWindowBudget());
    index.range.end = 1; expect((await pending).kind).toBe('progress'); Object.assign(index, JSON.parse(saved));
    const controller = new AbortController(); controller.abort(); const budget = createWindowBudget();
    await expect(advance(directory, receipt, index, initial, budget, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.indexBytes).toBe(0); expect(initial).toEqual(create(receipt, index));
  });

  it('batches a small root with fewer physical reads while retaining the original facts and the same request budget', async () => {
    const { receipt, index } = await captured([]), initial = create(receipt, index);
    let cursor = initial, oldBytes = 0;
    for (;;) {
      const budget = createWindowBudget(), result = await advance(directory, receipt, index, cursor, budget); oldBytes += budget.counters.indexBytes;
      if (result.kind === 'complete') break;
      if (result.kind !== 'progress') throw new Error('Missing root index'); cursor = result.state;
    }
    const budget = createWindowBudget(), batched = await advanceCommitRootBatch(directory, receipt, index, initial, budget);
    expect(batched.kind).toBe('complete');
    if (batched.kind !== 'complete') throw new Error('Small root did not complete');
    expect(batched.facts).toEqual((await fields(receipt, index)).facts);
    expect(budget.counters.indexBytes).toBeLessThan(oldBytes); expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
    expect(initial).toEqual(create(receipt, index));
  });

  it('keeps a giant opaque child bounded and cancellation silent without losing the caller checkpoint', async () => {
    const { receipt, index } = await captured(), input = create(receipt, index), budget = createWindowBudget();
    const result = await advanceCommitRootBatch(directory, receipt, index, input, budget);
    expect(['progress', 'complete']).toContain(result.kind); expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
    expect(input).toEqual(create(receipt, index));
    const abort = new AbortController(); abort.abort();
    await expect(advanceCommitRootBatch(directory, receipt, index, input, createWindowBudget(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
