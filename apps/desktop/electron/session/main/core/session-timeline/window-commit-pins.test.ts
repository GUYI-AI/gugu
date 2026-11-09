import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, readdir, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { windowCommitSourcePath, writeWindowCommitSource } from './window-commit-source';
import { openWindowCommitPins, type CommitVersion } from './window-commit-pins';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import type { WindowCommitReceipt } from './window-commit-receipt';

const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'version-pin-')); paths.push(directory);
  const receipts = new Map<string, WindowCommitReceipt>(), current = new Map<string, WindowCommitReceipt>();
  let lockHeld = true, protectedIntent = false;
  const input = { directory, proof: { namespace: directory, assertHeld() { if (!lockHeld) throw new Error('exclusive lock lost'); } },
    receipts: { bySource: (id: string) => receipts.get(id) ?? null, byRow: (id: string) => current.get(id) ?? null },
    async canCollect() { return !protectedIntent; } };
  async function version(): Promise<CommitVersion> {
    const sourceId = randomUUID(), binding = { scope: 'a'.repeat(64), sourceLineage: randomUUID().replaceAll('-', '').repeat(2), decoderVersion: 1 };
    const source = await writeWindowCommitSource(directory, binding, '{"text":"正文"}');
    const receipt: WindowCommitReceipt = { version: 1, sourceId, sessionId: 's', rowId: 's:0', referenceId: 'r', storedSeq: 0,
      firstCommitCursor: null, latestRevisionCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: receipts.size }, binding, source };
    receipts.set(sourceId, receipt); return { receipt, projectionId: `${sourceId}/${'b'.repeat(32)}` };
  }
  return { directory, input, version, current, receipts, setLock: (value: boolean) => { lockHeld = value; }, protect: () => { protectedIntent = true; } };
}
async function failSyncOnce(path: string, phase: 'before' | 'after') {
  const file = await open(path), identity = await file.stat({ bigint: true });
  const proto = Object.getPrototypeOf(file) as FileHandle, sync = proto.sync; await file.close(); let fail = true, directories = 0;
  vi.spyOn(proto, 'sync').mockImplementation(async function(this: FileHandle) {
    const current = await this.stat({ bigint: true }), root = current.dev === identity.dev && current.ino === identity.ino;
    if (root) directories++;
    if (fail && (phase === 'after' ? root : !current.isDirectory())) { fail = false; throw new Error('injected sync failure'); }
    await Reflect.apply(sync, this, []);
  });
  return () => directories;
}

describe('durable version pins under an exclusive gateway incarnation', () => {
  it.each(['begin', 'batch', 'finish', 'forget'] as const)('confirms directory durability after a published %s operation fails sync', async phase => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    if (phase === 'finish' || phase === 'forget') await pins.beginCollection(v, createWindowBudget());
    if (phase === 'forget') { await pins.finishCollection(v, createWindowBudget()); f.receipts.delete(v.receipt.sourceId); }
    const run = () => phase === 'finish' ? pins.finishCollection(v, createWindowBudget())
      : phase === 'forget' ? pins.forgetCollected(v, createWindowBudget()) : pins.beginCollection(v, createWindowBudget());
    const directories = await failSyncOnce(f.directory, 'after');
    await expect(run()).rejects.toThrow('injected sync failure'); expect(directories()).toBe(1);
    const remove = vi.fn(() => { expect(directories()).toBe(2); });
    if (phase === 'batch') await pins.withCollection(v, createWindowBudget(), async () => remove());
    else await run();
    expect(directories()).toBe(2);
    if (phase === 'batch') expect(remove).toHaveBeenCalledOnce();
  });

  it.each(['before', 'after'] as const)('keeps the other live reference when release retries a %s-publication sync failure', async phase => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version(), owner = {};
    const first = await pins.acquire(owner, v, createWindowBudget()), second = await pins.acquire(owner, v, createWindowBudget());
    const directories = await failSyncOnce(f.directory, phase);
    await expect(first(createWindowBudget())).rejects.toThrow('injected sync failure');
    await first(createWindowBudget()); expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned');
    expect(directories()).toBe(phase === 'after' ? 2 : 1);
    await second(createWindowBudget()); expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it.each(['before', 'after'] as const)('durably retries the last release after a %s-publication failure', async phase => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    const release = await pins.acquire({}, v, createWindowBudget()); await failSyncOnce(f.directory, phase);
    await expect(release(createWindowBudget())).rejects.toThrow('injected sync failure');
    await release(createWindowBudget()); expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it.each(['before', 'after'] as const)('retains failed-acquire cleanup ownership after a %s-publication failure', async phase => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version(), owner = {};
    await failSyncOnce(f.directory, phase); await expect(pins.acquire(owner, v, createWindowBudget())).rejects.toThrow('injected sync failure');
    expect(await pins.releaseOwner(owner, createWindowBudget())).toEqual({ complete: true });
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it('does not overwrite a newly acquired live token when an earlier failed release is retried', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version(), owner = {};
    const first = await pins.acquire(owner, v, createWindowBudget()), second = await pins.acquire(owner, v, createWindowBudget());
    await failSyncOnce(f.directory, 'after'); await expect(first(createWindowBudget())).rejects.toThrow('injected sync failure');
    const third = await pins.acquire(owner, v, createWindowBudget()); await second(createWindowBudget()); await first(createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned'); await third(createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it('does not resurrect a pin head when collection finishes before a failed last-release retry', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    const release = await pins.acquire({}, v, createWindowBudget()); await failSyncOnce(f.directory, 'after');
    await expect(release(createWindowBudget())).rejects.toThrow('injected sync failure');
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting'); await pins.finishCollection(v, createWindowBudget());
    f.receipts.delete(v.receipt.sourceId); await pins.forgetCollected(v, createWindowBudget()); await release(createWindowBudget());
    await expect(open(join(f.directory, windowFrameName({ ...v.receipt.binding, kind: 'head', cursor: `version:pin:${v.receipt.sourceId}` }))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not carry an unissued failed acquire into the next successful lease count', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version(), owner = {};
    await failSyncOnce(f.directory, 'after'); await expect(pins.acquire(owner, v, createWindowBudget())).rejects.toThrow('injected sync failure');
    const release = await pins.acquire(owner, v, createWindowBudget()); await release(createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it('retains duplicate resident references until both explicit releases, independently of any ACK', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version(), owner = {};
    const release1 = await pins.acquire(owner, v, createWindowBudget()), release2 = await pins.acquire(owner, v, createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned');
    await release1(createWindowBudget()); await release1(createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned');
    await release2(createWindowBudget()); expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
    await expect(pins.acquire(owner, v, createWindowBudget())).rejects.toMatchObject({ code: 'version_collecting' });
  });

  it('isolates owner replacement and closes at most one version per cleanup batch', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), first = await f.version(), second = await f.version();
    const oldOwner = {}, newOwner = {};
    const releaseOld = await pins.acquire(oldOwner, first, createWindowBudget());
    await pins.acquire(newOwner, first, createWindowBudget()); await pins.acquire(oldOwner, second, createWindowBudget());
    expect(await pins.releaseOwner(oldOwner, createWindowBudget())).toEqual({ complete: false });
    expect(await pins.releaseOwner(oldOwner, createWindowBudget())).toEqual({ complete: true });
    await releaseOld(createWindowBudget());
    expect(await pins.beginCollection(first, createWindowBudget())).toBe('pinned');
    expect(await pins.beginCollection(second, createWindowBudget())).toBe('collecting');
    await expect(pins.acquire(oldOwner, first, createWindowBudget())).rejects.toMatchObject({ code: 'unsubscribed' });
  });

  it('requires a positive exclusive-lock proof before writing an epoch or recovering persisted pins', async () => {
    const f = await fixture(); f.setLock(false);
    await expect(openWindowCommitPins(f.input)).rejects.toThrow('exclusive lock lost'); expect(await readdir(f.directory)).toEqual([]);
    f.setLock(true); const old = await openWindowCommitPins(f.input), v = await f.version();
    const releaseOld = await old.acquire({}, v, createWindowBudget());
    f.setLock(false); await expect(releaseOld(createWindowBudget())).rejects.toThrow('exclusive lock lost');
    f.setLock(true); await expect(releaseOld(createWindowBudget())).rejects.toMatchObject({ code: 'gateway_invalidated' });
    const reopened = await openWindowCommitPins(f.input);
    expect(await reopened.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it('never lets an old gateway disposer erase a new gateway owner, including concurrent queued operations', async () => {
    const f = await fixture(), old = await openWindowCommitPins(f.input), v = await f.version();
    const release = await old.acquire({}, v, createWindowBudget());
    const current = await openWindowCommitPins(f.input);
    const [newPin, oldRelease] = await Promise.allSettled([current.acquire({}, v, createWindowBudget()), release(createWindowBudget())]);
    expect(newPin.status).toBe('fulfilled'); expect(oldRelease).toMatchObject({ status: 'rejected', reason: { code: 'gateway_epoch_changed' } });
    expect(await current.beginCollection(v, createWindowBudget())).toBe('pinned');
  });

  it('rechecks lock ownership after an actual async head read, before querying a receipt or changing a pin', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    const file = await open(windowCommitSourcePath(f.directory, v.receipt.binding));
    const proto = Object.getPrototypeOf(file) as FileHandle, original = proto.read; await file.close();
    vi.spyOn(proto, 'read').mockImplementation((async function(this: FileHandle, target: Uint8Array, offset: number, length: number, position: number) {
      const result = await Reflect.apply(original, this, [target, offset, length, position]); f.setLock(false); return result;
    }) as typeof original);
    const query = vi.spyOn(f.input.receipts, 'bySource'), budget = createWindowBudget();
    await expect(pins.acquire({}, v, budget)).rejects.toThrow('exclusive lock lost');
    expect(budget.counters.indexBytes).toBeGreaterThan(0); expect(query).not.toHaveBeenCalled(); vi.restoreAllMocks();
    f.setLock(true); const restarted = await openWindowCommitPins(f.input);
    expect(await restarted.beginCollection(v, createWindowBudget())).toBe('collecting');
  });

  it('protects current canonical versions, builds, and recovery intents without skipping an uncollectable version', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    f.current.set(v.receipt.rowId, v.receipt); expect(await pins.beginCollection(v, createWindowBudget())).toBe('current');
    f.current.clear(); const release = await pins.holdBuild({}, v.receipt, createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned'); await release(createWindowBudget());
    f.protect(); expect(await pins.beginCollection(v, createWindowBudget())).toBe('protected');
  });

  it('leaves pins intact on an exhausted shared budget or pre-cancellation and resumes a durable collection claim', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    const release = await pins.acquire({}, v, createWindowBudget()), budget = createWindowBudget();
    await budget.read('indexBytes', 65536, async () => 65536);
    await expect(release(budget)).rejects.toThrow('budget exhausted');
    const abort = new AbortController(); abort.abort();
    await expect(pins.beginCollection(v, createWindowBudget(), abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned'); await release(createWindowBudget());
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
    const restarted = await openWindowCommitPins(f.input);
    expect(await restarted.beginCollection(v, createWindowBudget())).toBe('collecting');
    await restarted.finishCollection(v, createWindowBudget());
    expect(await restarted.beginCollection(v, createWindowBudget())).toBe('collected');
  });

  it('does not use a positive proof for a different DB namespace to retire this namespace owner', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    await pins.acquire({}, v, createWindowBudget());
    const foreign = await openWindowCommitPins({ ...f.input, proof: { ...f.input.proof, namespace: `${f.directory}:different-db` } });
    await expect(foreign.beginCollection(v, createWindowBudget())).rejects.toMatchObject({ code: 'pin_namespace_changed' });
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('pinned');
  });

  it('serializes a bounded collection batch against new acquisitions and makes retired-head cleanup retryable', async () => {
    const f = await fixture(), pins = await openWindowCommitPins(f.input), v = await f.version();
    expect(await pins.beginCollection(v, createWindowBudget())).toBe('collecting');
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const collect = pins.withCollection(v, createWindowBudget(), async check => { entered.resolve(); await gate.promise; check(); return 'batch'; });
    await entered.promise; const acquisition = pins.acquire({}, v, createWindowBudget());
    gate.resolve(); expect(await collect).toBe('batch');
    await expect(acquisition).rejects.toMatchObject({ code: 'version_collecting' });
    await pins.finishCollection(v, createWindowBudget());
    await expect(pins.forgetCollected(v, createWindowBudget())).rejects.toMatchObject({ code: 'commit_receipt_retained' });
    f.receipts.delete(v.receipt.sourceId);
    await pins.forgetCollected(v, createWindowBudget()); await pins.forgetCollected(v, createWindowBudget());
  });
});
