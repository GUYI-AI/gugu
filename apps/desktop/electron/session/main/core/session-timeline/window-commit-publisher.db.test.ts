import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as frames from '@gugu/session-core/session-record/window-cache/disk-frame';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import * as disk from '@gugu/session-core/session-record/window-cache/disk-frame';
import { createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { createWindowCommitPublisher, readPublishedCommitEntity, readWindowCommitPublication, readWindowCommitPublicationVersion } from './window-commit-publisher';
import { openCommitBodySlot, readCommitBodySlot } from './window-commit-slot';
import * as source from './window-commit-source';
import { readCommitHeader } from './window-commit-header';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

describe('complete durable canonical commit publisher', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, directory: string, receipt: WindowCommitReceipt;
  const huge = 'real message 中文😀 \\ "\n'.repeat(10000);
  const tools = (depth: number): Extract<TranscriptTurn['items'][number], { kind: 'mcp-tool-call' }> => ({
    kind: 'mcp-tool-call', id: `runtime:0:tool:${depth}`, seq: depth, toolCallId: `provider-${depth}`, tool: 'read', title: 'Read', status: 'done',
    ...(depth < 3 ? { children: [tools(depth + 1)] } : { rawOutput: 'deep result' }),
  });
  const turn = (): TranscriptTurn => ({ id: 'runtime:0', seq: 0, referenceId: 'ref', initiator: 'user', items: [tools(0),
    { kind: 'message', id: 'runtime:0:first', seq: 4, role: 'assistant', text: huge },
    { kind: 'message', id: 'runtime:0:last', seq: 5, role: 'assistant', text: '' }],
  terminals: [{ terminalId: 'terminal', owner: 'agent', canKill: false, command: 'true', args: [], cwd: '/fixture', output: 'terminal body', truncated: false, exitStatus: null }] });
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite; fixture.sqlite.pragma('synchronous=FULL');
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    directory = await mkdtemp(join(tmpdir(), 'commit-publisher-'));
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: turn(), windowCapture: { directory, scope: 'a'.repeat(64),
      cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 3 }, committed: async () => {} } });
    receipt = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'ref')!;
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }); });
  const context = () => ({ directory, receipt, receipts: createWindowCommitReceipts(fixture.sqlite) });

  it('publishes real rendering headers before the complete version, keeping message body out of its header', async () => {
    const c = context(), published = await createWindowCommitPublisher(directory, c.receipts).publish(receipt);
    const root = await readCommitHeader({ ...c, target: 'turn', range: { start: 0, end: receipt.source.bytes } }, published.buildId, createWindowBudget());
    expect(root.values).toMatchObject({ referenceId: receipt.referenceId, seq: receipt.storedSeq, initiator: 'user' });
    expect(root.values).not.toHaveProperty('startedAt');
    const row = await readPublishedCommitEntity(c, published.projectionId, 4, createWindowBudget());
    const header = await readCommitHeader({ ...c, target: 'item', range: row.position.range }, row.entityId, createWindowBudget());
    expect(header.values).toMatchObject({ id: row.facts.id, kind: 'message', seq: 4, role: 'assistant' });
    expect(JSON.stringify(header)).not.toContain('real message');
  }, 30000);

  it('persists only changed outer recovery cursors while inner structural checkpoints progress', async () => {
    const write = frames.writeWindowFrame, heads: Buffer[] = [];
    vi.spyOn(frames, 'writeWindowFrame').mockImplementation(async (...args) => {
      if (args[1].cursor === 'publisher:job') heads.push(Buffer.from(args[2]));
      return write(...args);
    });
    await createWindowCommitPublisher(directory, context().receipts).publish(receipt);
    expect(heads.length).toBeGreaterThan(2);
    expect(heads.slice(1).every((bytes, index) => !bytes.equals(heads[index]))).toBe(true);
  }, 30000);

  it('publishes a complete ordered tree and terminal with seekable genuine body/parent positions', async () => {
    const c = context(), io: { indexBytes: number; sourceBytes: number }[] = [], phase = vi.fn();
    const publisher = createWindowCommitPublisher(directory, c.receipts, { observed: counters => io.push({ ...counters }), phase });
    const p = await publisher.publish(receipt); expect(p.count).toBe(7); expect(p.nodes).toBe(2);
    expect(await readWindowCommitPublication(c, createWindowBudget())).toEqual(p);
    expect(phase).toHaveBeenCalledExactlyOnceWith('projection_durable', p);
    expect(io.every(counters => counters.indexBytes <= 65536 && counters.sourceBytes === 0)).toBe(true);
    const parentIds: string[] = [];
    for (let ordinal = 0; ordinal < p.count; ordinal++) {
      const budget = createWindowBudget(), row = await readPublishedCommitEntity(c, p.projectionId, ordinal, budget);
      expect(budget.counters.indexBytes).toBeLessThanOrEqual(65536);
      expect(row.parent).toBe(ordinal > 0 && ordinal < 4 ? parentIds[ordinal - 1] : null); parentIds.push(row.entityId);
      expect(row.facts.entity).toBe(ordinal === 6 ? 'terminal' : 'item');
      if (ordinal >= 4) {
        const slot = openCommitBodySlot(directory, c.receipts, receipt, row.facts, ordinal === 6 ? 'output' : 'text', row.bodyBuildId);
        const body = await readCommitBodySlot(slot, 0, createWindowBudget()); if (body.kind !== 'body') throw new Error('Missing durable body');
        expect(body.text).toBe(ordinal === 4 ? huge.slice(0, body.text.length) : ordinal === 5 ? '' : 'terminal body');
      }
    }
    expect(await createWindowCommitPublisher(directory, c.receipts).publish(receipt)).toEqual(p);
    await expect(readPublishedCommitEntity(c, p.projectionId, p.count, createWindowBudget())).rejects.toThrow('outside');
  }, 30000);
  it('resumes the same ordinal and immutable entity after interruption between locator and checkpoint', async () => {
    const c = context(), original = disk.writeWindowFrame; let interrupted = false;
    await expect(readWindowCommitPublication(c, createWindowBudget())).rejects.toMatchObject({ code: 'needs_location' });
    const write = vi.spyOn(disk, 'writeWindowFrame').mockImplementation(async (dir, key, bytes) => {
      if (key.cursor === 'publisher:job' && !interrupted && JSON.parse(Buffer.from(bytes).toString()).count === 1) {
        interrupted = true; throw Object.assign(new Error('checkpoint failed'), { code: 'EIO' });
      }
      await original(dir, key, bytes);
    });
    await expect(createWindowCommitPublisher(directory, c.receipts).publish(receipt)).rejects.toMatchObject({ code: 'EIO' }); write.mockRestore();
    await expect(readWindowCommitPublication(c, createWindowBudget())).rejects.toMatchObject({ code: 'needs_location' });
    const p = await createWindowCommitPublisher(directory, c.receipts).publish(receipt); expect(p.count).toBe(7);
    const first = await readPublishedCommitEntity(c, p.projectionId, 0, createWindowBudget());
    expect(first.facts.id).toBe('c:turn:s0:tool:0');
    const last = await readPublishedCommitEntity(c, p.projectionId, 6, createWindowBudget()); expect(last.facts.id).toBe('terminal');
  }, 30000);
  it('keeps an old published version unchanged after canonical revision changes the latest source', async () => {
    const c = context(), publisher = createWindowCommitPublisher(directory, c.receipts), old = await publisher.publish(receipt);
    await persistCommittedTurn({ sessionId: 'c', source: 'revision', turn: { ...turn(), items: [] }, windowCapture: { directory,
      scope: 'a'.repeat(64), cursor: { workerEpoch: 'worker', storeEpoch: 'store', sequence: 10 }, committed: async () => {} } });
    const next = c.receipts.bySource(receipt.sourceId); expect(next).toEqual(receipt);
    const latest = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'ref')!;
    expect(latest.sourceId).not.toBe(receipt.sourceId); const changed = await publisher.publish(latest); expect(changed.count).toBe(1);
    expect((await readPublishedCommitEntity(c, old.projectionId, 4, createWindowBudget())).facts.kind).toBe('message');
  }, 30000);
  it('cancels without waking another build and refuses a successful publication after canonical deletion', async () => {
    const c = context(), abort = new AbortController(); abort.abort();
    await expect(createWindowCommitPublisher(directory, c.receipts).publish(receipt, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const publisher = createWindowCommitPublisher(directory, c.receipts, { phase() { fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(receipt.rowId); } });
    const pending = publisher.publish(receipt);
    await expect(publisher.publish(receipt)).rejects.toThrow('occupied');
    await expect(pending).rejects.toThrow('committed receipt');
  }, 30000);
  it.each(['latest', 'version'])('point-reads %s only while its receipt survives the final asynchronous source check', async kind => {
    const c = context(), published = await createWindowCommitPublisher(directory, c.receipts).publish(receipt);
    const validate = source.assertWindowCommitSource;
    vi.spyOn(source, 'assertWindowCommitSource').mockImplementation(async (...args) => {
      await validate(...args); queueMicrotask(() => fixture.sqlite.prepare('DELETE FROM session_turns WHERE id=?').run(c.receipt.rowId));
    });
    await expect(kind === 'latest' ? readWindowCommitPublication(c, createWindowBudget())
      : readWindowCommitPublicationVersion(c, published.projectionId, createWindowBudget())).rejects.toThrow('committed receipt');
  }, 30000);
});
