import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { windowFrameName } from '@gugu/session-core/session-record/window-cache/frame';
import { readWindowFrame, writeWindowFrame, syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { snapshotWindowCommitReceipt, type WindowCommitReceipt, type createWindowCommitReceipts } from './window-commit-receipt';

export type CommitSourceVersion = { receipt: WindowCommitReceipt };
export type CommitVersion = CommitSourceVersion & { projectionId: string };
export type WindowGatewayProof = { namespace: string; assertHeld(): void };
type Receipt = WindowCommitReceipt;
type State = { version: 1; sourceId: string; namespace: string; epoch: string; stage: 'active' | 'collecting' | 'collected'; holders: { id: string; count: number }[] };
type Held = { receipt: Receipt; tokens: Set<object> };
type Owner = { id: string; closed: boolean; versions: Map<string, Held> };
const tails = new Map<string, Promise<void>>();
function serial<T>(namespace: string, run: () => Promise<T>): Promise<T> {
  const next = (tails.get(namespace) ?? Promise.resolve()).then(run, run);
  const tail = next.then(() => {}, () => {}); tails.set(namespace, tail);
  void tail.then(() => { if (tails.get(namespace) === tail) tails.delete(namespace); });
  return next;
}
const key = (r: Receipt) => ({ ...r.binding, kind: 'head' as const, cursor: `version:pin:${r.sourceId}` });
const fault = (code: string) => Object.assign(new Error(code), { code });
function parse(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }

/** The proof must attest the exact DB/cache namespace's exclusive gateway lock,
 * including throughout every async operation. A new random epoch alone proves
 * nothing. No expiry, PID guess, directory scan or public release token here. */
export async function openWindowCommitPins(input: {
  directory: string; proof: WindowGatewayProof;
  receipts: Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource' | 'byRow'>;
  canCollect(version: CommitSourceVersion, budget: WindowBudget, signal?: AbortSignal): Promise<boolean>;
}, signal?: AbortSignal) {
  input.proof.assertHeld(); signal?.throwIfAborted();
  const directory = await realpath(input.directory), epoch = randomUUID();
  const scope = createHash('sha256').update(input.proof.namespace).digest('hex');
  const epochKey = { scope, sourceLineage: scope, decoderVersion: 1, kind: 'head' as const, cursor: 'version:gateway' };
  const namespace = directory, owners = new WeakMap<object, Owner>();
  let invalid = false;
  function proof() {
    if (invalid) throw fault('gateway_invalidated');
    try { input.proof.assertHeld(); } catch (error) { invalid = true; throw error; }
  }
  const check = () => { proof(); signal?.throwIfAborted(); };
  await serial(namespace, async () => { check(); await writeWindowFrame(directory, epochKey, Buffer.from(JSON.stringify({ version: 1, epoch }))); check(); });
  async function current(b: WindowBudget, abort?: AbortSignal) {
    proof(); abort?.throwIfAborted();
    const found = await readWindowFrame(directory, epochKey, b);
    proof(); abort?.throwIfAborted();
    if (found.kind === 'miss' && found.reason === 'io') throw found.error;
    const saved = found.kind === 'hit' ? parse(found.bytes) as { version: number; epoch: string } : null;
    if (saved?.version !== 1 || saved.epoch !== epoch) throw fault('gateway_epoch_changed');
  }
  async function readState(receipt: Receipt, b: WindowBudget): Promise<{ found: boolean; state: State }> {
    const found = await readWindowFrame(directory, key(receipt), b);
    if (found.kind === 'miss') {
      if (found.reason === 'not_found') return { found: false, state: { version: 1, sourceId: receipt.sourceId, namespace: scope, epoch, stage: 'active', holders: [] } };
      throw found.reason === 'io' ? found.error : fault('invalid_version_pin');
    }
    const s = parse(found.bytes) as State;
    if (s?.namespace !== scope) throw fault('pin_namespace_changed');
    if (s?.version !== 1 || s.sourceId !== receipt.sourceId || typeof s.epoch !== 'string'
      || !['active', 'collecting', 'collected'].includes(s.stage) || !Array.isArray(s.holders)
      || s.holders.some(h => !h || typeof h.id !== 'string' || !/^[a-f0-9-]{36}$/.test(h.id)
        || !Number.isSafeInteger(h.count) || h.count < 1) || new Set(s.holders.map(h => h.id)).size !== s.holders.length)
      throw fault('invalid_version_pin');
    // current() and the held exclusive lock prove prior gateway capabilities
    // cannot still issue reads. Collection progress survives incarnation changes.
    return { found: true, state: { ...s, epoch, holders: s.epoch === epoch ? s.holders : [] } };
  }
  const load = async (receipt: Receipt, b: WindowBudget) => (await readState(receipt, b)).state;
  async function save(receipt: Receipt, s: State) {
    proof(); await writeWindowFrame(directory, key(receipt), Buffer.from(JSON.stringify(s))); proof();
  }
  function owner(object: object) {
    let selected = owners.get(object);
    if (!selected) { selected = { id: randomUUID(), closed: false, versions: new Map() }; owners.set(object, selected); }
    return selected;
  }
  function committed(receipt: Receipt) {
    const found = input.receipts.bySource(receipt.sourceId);
    if (!found || JSON.stringify(snapshotWindowCommitReceipt(found)) !== JSON.stringify(receipt)) throw fault('commit_receipt_changed');
  }
  async function hold(object: object, inputReceipt: Receipt, b: WindowBudget, abort?: AbortSignal) {
    const receipt = snapshotWindowCommitReceipt(inputReceipt), selected = owner(object), token = {};
    await serial(namespace, async () => {
      await current(b, abort); if (selected.closed) throw fault('unsubscribed'); committed(receipt);
      const s = await load(receipt, b); if (s.stage !== 'active') throw fault('version_collecting');
      const h = s.holders.find(value => value.id === selected.id);
      if (h) h.count++; else s.holders.push({ id: selected.id, count: 1 });
      abort?.throwIfAborted(); await save(receipt, s);
      const held = selected.versions.get(receipt.sourceId) ?? { receipt, tokens: new Set<object>() };
      held.tokens.add(token); selected.versions.set(receipt.sourceId, held);
    });
    return async (releaseBudget: WindowBudget, releaseSignal?: AbortSignal) => serial(namespace, async () => {
      const held = selected.versions.get(receipt.sourceId); if (!held?.tokens.has(token)) return;
      await current(releaseBudget, releaseSignal); const s = await load(receipt, releaseBudget);
      const h = s.holders.find(value => value.id === selected.id); if (!h) throw fault('version_pin_lost');
      if (--h.count === 0) s.holders = s.holders.filter(value => value !== h);
      releaseSignal?.throwIfAborted(); await save(receipt, s); held.tokens.delete(token);
      if (!held.tokens.size) selected.versions.delete(receipt.sourceId);
    });
  }
  return {
    namespace: scope,
    /** Namespace metadata cleanup shares acquire's queue and epoch proof. */
    withGateway<T>(b: WindowBudget, run: (check: () => void) => Promise<T>, abort?: AbortSignal) {
      return serial(namespace, async () => {
        await current(b, abort); const held = () => { proof(); abort?.throwIfAborted(); };
        held(); try { return await run(held); } finally { proof(); }
      });
    },
    acquire(object: object, version: CommitVersion, b: WindowBudget, abort?: AbortSignal) {
      if (version.projectionId !== `${version.receipt.sourceId}/${version.projectionId.split('/')[1]}`
        || !/^[a-f0-9]{32}$/.test(version.projectionId.split('/')[1] ?? '')) throw fault('invalid_projection_version');
      return hold(object, version.receipt, b, abort);
    },
    holdBuild: hold,
    /** One version per call. stop closes the owner immediately; its bounded
     * cleanup job calls again with the next batch's budget until complete. */
    releaseOwner(object: object, b: WindowBudget, abort?: AbortSignal) {
      const selected = owner(object); selected.closed = true;
      return serial(namespace, async () => {
        const first = selected.versions.values().next().value as Held | undefined;
        if (!first) return { complete: true };
        await current(b, abort); const s = await load(first.receipt, b);
        s.holders = s.holders.filter(h => h.id !== selected.id);
        abort?.throwIfAborted(); await save(first.receipt, s); first.tokens.clear(); selected.versions.delete(first.receipt.sourceId);
        return { complete: selected.versions.size === 0 };
      });
    },
    /** The collector must additionally prove no source/recovery or unfinished
     * build intent. Claim is durable before unlinking any version artifacts. */
    beginCollection(version: CommitSourceVersion, b: WindowBudget, abort?: AbortSignal) {
      const receipt = snapshotWindowCommitReceipt(version.receipt);
      const selected = { receipt };
      return serial(namespace, async () => {
        await current(b, abort); const s = await load(receipt, b);
        if (s.holders.length) return 'pinned' as const;
        if (input.receipts.byRow(receipt.rowId)?.sourceId === receipt.sourceId) return 'current' as const;
        if (s.stage !== 'active') return s.stage;
        if (!await input.canCollect(selected, b, abort)) return 'protected' as const;
        abort?.throwIfAborted(); s.stage = 'collecting'; await save(receipt, s); return 'collecting' as const;
      });
    },
    finishCollection(version: CommitSourceVersion, b: WindowBudget, abort?: AbortSignal) {
      const receipt = snapshotWindowCommitReceipt(version.receipt);
      return serial(namespace, async () => {
        await current(b, abort); const s = await load(receipt, b);
        if (s.stage !== 'collecting' || s.holders.length) throw fault('version_not_collecting');
        abort?.throwIfAborted(); s.stage = 'collected'; await save(receipt, s);
      });
    },
    /** One bounded collector batch holds the same namespace queue as acquire.
     * check() must precede mutations and follow each async filesystem boundary. */
    withCollection<T>(version: CommitSourceVersion, b: WindowBudget, remove: (check: () => void) => Promise<T>, abort?: AbortSignal) {
      const receipt = snapshotWindowCommitReceipt(version.receipt);
      return serial(namespace, async () => {
        await current(b, abort); const s = await load(receipt, b);
        if (s.stage !== 'collecting' || s.holders.length || input.receipts.byRow(receipt.rowId)?.sourceId === receipt.sourceId)
          throw fault('version_not_collecting');
        const held = () => { proof(); abort?.throwIfAborted(); }; held();
        try { return await remove(held); } finally { proof(); }
      });
    },
    /** Only after artifact deletion and the retired receipt's removal. The
     * absence of that head makes a retry idempotent, not a new collection job. */
    forgetCollected(version: CommitSourceVersion, b: WindowBudget, abort?: AbortSignal) {
      const receipt = snapshotWindowCommitReceipt(version.receipt);
      return serial(namespace, async () => {
        await current(b, abort); const loaded = await readState(receipt, b);
        if (input.receipts.bySource(receipt.sourceId)) throw fault('commit_receipt_retained');
        if (!loaded.found) return;
        if (loaded.state.stage !== 'collected' || loaded.state.holders.length) throw fault('version_not_collected');
        abort?.throwIfAborted(); proof(); await rm(join(directory, windowFrameName(key(receipt))), { force: true });
        proof(); await syncWindowDirectory(directory); proof();
      });
    },
  };
}
