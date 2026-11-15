import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { beginWindowCommitIntent, readWindowCommitIntent, windowCommitIntentBinding } from './window-commit-intent';
import { createWindowCommitPublisher } from './window-commit-publisher';
import { windowCommitProjectionDirectory } from './window-commit-projection-disk';
import { windowCommitSourcePath, writeWindowCommitSource } from './window-commit-source';
import { openWindowCommitPins } from './window-commit-pins';
import type { WindowCommitReceipt } from './window-commit-receipt';
import { readWindowCommitCollectionGuard } from './window-commit-collection-guard';

const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collection-guard-')); paths.push(directory);
  const sourceId = randomUUID(), scope = 'a'.repeat(64), binding = windowCommitIntentBinding(scope, sourceId);
  const source = await writeWindowCommitSource(directory, binding, JSON.stringify({ id: 's:turn', seq: 0, referenceId: 'ref',
    initiator: 'user', items: [], terminals: [] }));
  const receipt: WindowCommitReceipt = { version: 1, sourceId, sessionId: 's', rowId: 's:0', referenceId: 'ref', storedSeq: 0,
    firstCommitCursor: null, latestRevisionCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 0 }, binding, source };
  const records = new Map<string, WindowCommitReceipt>([[sourceId, receipt]]);
  const receipts = { bySource: (id: string) => records.get(id) ?? null, byRow: () => null };
  const intent = { version: 1 as const, sourceId, sessionId: 's', rowId: 's:0', referenceId: 'ref', storedSeq: 0 };
  const input = { directory, scope, sessionId: 's' };
  const read = (budget = createWindowBudget(), signal?: AbortSignal) => readWindowCommitCollectionGuard(directory, { receipt }, budget, signal);
  return { directory, receipt, records, receipts, intent, input, read };
}
async function meter(f: Awaited<ReturnType<typeof fixture>>, afterRead?: () => void) {
  const file = await open(windowCommitSourcePath(f.directory, f.receipt.binding)), source = await file.stat({ bigint: true });
  const proto = Object.getPrototypeOf(file) as FileHandle, original = proto.read; await file.close(); let bytes = 0;
  vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
    const identity = await this.stat({ bigint: true });
    if (identity.dev === source.dev && identity.ino === source.ino) throw new Error('Guard read a source body');
    const result = await Reflect.apply(original, this, [target, offset, length, position]); bytes += result.bytesRead; afterRead?.(); return result;
  }) as typeof original);
  return () => bytes;
}

describe('read-only bounded source/build collection guard', () => {
  it('reports only disk intent absence without creating a head or reading the source', async () => {
    const f = await fixture(), actual = await meter(f), budget = createWindowBudget();
    expect(await f.read(budget)).toBe('clear'); expect(actual()).toBe(0); expect(budget.counters.indexBytes).toBe(0);
  });
  it('protects a source intent without recovering it, but does not confuse another UUID with this source', async () => {
    const f = await fixture(); await beginWindowCommitIntent(f.input, f.intent);
    const actual = await meter(f), budget = createWindowBudget();
    expect(await f.read(budget)).toBe('source_intent'); expect(budget.counters.indexBytes).toBe(actual());
    expect(budget.counters.sourceBytes).toBe(0); expect(actual()).toBeGreaterThan(0);
    expect(await readWindowCommitIntent(f.input, createWindowBudget())).toEqual(f.intent);
    await beginWindowCommitIntent(f.input, { ...f.intent, sourceId: randomUUID() }); expect(await f.read()).toBe('clear');
  });
  it('protects an actual interrupted publisher checkpoint and verifies its real completion record after resume', async () => {
    const f = await fixture(), abort = new AbortController();
    await expect(createWindowCommitPublisher(f.directory, f.receipts, { observed() { abort.abort(); } })
      .publish(f.receipt, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await f.read()).toBe('build_intent');
    await createWindowCommitPublisher(f.directory, f.receipts).publish(f.receipt); f.records.clear();
    const actual = await meter(f), budget = createWindowBudget();
    expect(await f.read(budget)).toBe('clear'); expect(budget.counters.indexBytes).toBe(actual());
    expect(actual()).toBeGreaterThan(0); expect(actual()).toBeLessThan(8192); expect(budget.counters.sourceBytes).toBe(0);
  });
  it.each(['corrupt job', 'missing publication'] as const)('refuses clear for %s instead of rebuilding or returning success', async damage => {
    const f = await fixture(), p = await createWindowCommitPublisher(f.directory, f.receipts).publish(f.receipt);
    const name = windowFrameName({ ...f.receipt.binding, kind: damage === 'corrupt job' ? 'head' : 'projection',
      cursor: damage === 'corrupt job' ? 'publisher:job' : `publisher:${p.buildId}:publication` });
    const path = join(windowCommitProjectionDirectory(f.directory, f.receipt.binding), name);
    if (damage === 'corrupt job') await writeFile(path, 'corrupt'); else await rm(path);
    await expect(f.read()).rejects.toThrow();
  });
  it('keeps delivery and resident pins after publisher completion, and blocks a new builder after collection claims', async () => {
    const f = await fixture(), pins = await openWindowCommitPins({ directory: f.directory,
      proof: { namespace: f.directory, assertHeld() {} }, receipts: f.receipts,
      canCollect: async (version, budget, signal) => (await readWindowCommitCollectionGuard(f.directory, version, budget, signal)) === 'clear' });
    const build = await pins.holdBuild({}, f.receipt, createWindowBudget()), delivery = await pins.holdBuild({}, f.receipt, createWindowBudget());
    const publication = await createWindowCommitPublisher(f.directory, f.receipts).publish(f.receipt); await build(createWindowBudget());
    expect(await f.read()).toBe('clear'); expect(await pins.beginCollection({ receipt: f.receipt }, createWindowBudget())).toBe('pinned');
    const resident = await pins.acquire({}, { receipt: f.receipt, projectionId: publication.projectionId }, createWindowBudget());
    await delivery(createWindowBudget()); expect(await pins.beginCollection({ receipt: f.receipt }, createWindowBudget())).toBe('pinned');
    await resident(createWindowBudget()); expect(await pins.beginCollection({ receipt: f.receipt }, createWindowBudget())).toBe('collecting');
    await expect(pins.holdBuild({}, f.receipt, createWindowBudget())).rejects.toMatchObject({ code: 'version_collecting' });
  });
  it.each(['budget', 'cancel before', 'cancel after'] as const)('preserves intent and actual metering on %s', async mode => {
    const f = await fixture(); await beginWindowCommitIntent(f.input, f.intent);
    const budget = createWindowBudget(), abort = new AbortController(), actual = await meter(f, () => { if (mode === 'cancel after') abort.abort(); });
    if (mode === 'budget') await budget.read('indexBytes', 65536, async () => 65536); else if (mode === 'cancel before') abort.abort();
    await expect(f.read(budget, abort.signal)).rejects.toThrow();
    expect(actual() > 0).toBe(mode === 'cancel after');
    if (mode === 'cancel after') expect(budget.counters.indexBytes).toBe(actual());
    expect(await readWindowCommitIntent(f.input, createWindowBudget())).toEqual(f.intent);
  });
});
