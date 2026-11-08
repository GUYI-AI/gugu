import { readWindowFrame, writeWindowFrame } from '@gugu/session-core/session-record/window-cache/disk-frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { advanceCommitContainerIndex, readIndexedCommitContainerPage, type CommitContainerIndex } from './window-commit-container-index';
import { advanceCommitRootFields, advanceCommitRootBatch, createCommitRootState, resumeCommitRootState, type CommitRootState, type CommitRootFacts } from './window-commit-root';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { assertWindowCommitSource } from './window-commit-source';

type Receipts = Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'>;
type Stage = 'root-index' | 'root-fields' | 'items-index' | 'terminals-index' | 'publish';
type Head = { version: 1; sourceId: string; buildId: string; stage: Stage; root: CommitRootState };
type Context = { directory: string; receipts: Receipts; receipt: WindowCommitReceipt; buildId: string };
const stages: readonly Stage[] = ['root-index', 'root-fields', 'items-index', 'terminals-index', 'publish'];
const identifier = (id: string) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(id);
function snapshot(input: Context): Context {
  if (!identifier(input.buildId)) throw new Error('Invalid projection build id');
  const receipt = snapshotWindowCommitReceipt(input.receipt);
  // Only a transactional receipt authorizes recovery. The immutable source
  // manifest alone cannot prove that its canonical row ever committed.
  const stored = input.receipts.bySource(receipt.sourceId);
  if (!stored || JSON.stringify(snapshotWindowCommitReceipt(stored)) !== JSON.stringify(receipt))
    throw new Error('Projection needs its actual committed receipt');
  return { directory: input.directory, receipts: input.receipts, receipt, buildId: input.buildId };
}
function index(c: Context, part: 'root' | 'items' | 'terminals', range = { start: 0, end: c.receipt.source.bytes }): CommitContainerIndex {
  return { buildId: `${c.buildId}-${part}`, kind: part === 'root' ? 'object' : 'array', range: { ...range } };
}
function key(c: Context, publication: boolean) {
  return { ...c.receipt.binding, kind: publication ? 'projection' as const : 'head' as const,
    cursor: `commit-projection:${c.buildId}:${publication ? 'publication' : 'checkpoint'}` };
}
function bytes(value: Head): Uint8Array {
  const result = Buffer.from(JSON.stringify(value));
  if (result.length > 3500) throw new Error('Projection checkpoint exceeds its bounded frame');
  return result;
}
function parse(c: Context, raw: Uint8Array): Head {
  if (raw.length > 3500) throw new Error('Invalid projection checkpoint size');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as Head;
  if (!value || value.version !== 1 || value.sourceId !== c.receipt.sourceId || value.buildId !== c.buildId
    || !stages.includes(value.stage) || !value.root || value.root.version !== 1 || value.root.sourceId !== c.receipt.sourceId
    || value.root.buildId !== index(c, 'root').buildId || (value.stage !== 'root-index' && value.stage !== 'root-fields' && value.root.done !== true))
    throw new Error('Invalid projection checkpoint');
  return { version: 1, sourceId: value.sourceId, buildId: value.buildId, stage: value.stage,
    root: resumeCommitRootState(c.receipt, index(c, 'root'), value.root) };
}
async function load(c: Context, publication: boolean, budget: WindowBudget) {
  const result = await readWindowFrame(c.directory, key(c, publication), budget);
  if (result.kind === 'miss' && result.reason === 'io') throw result.error;
  return result;
}
const rebuild = (c: Context) => ({ kind: 'rebuild' as const, anchor: { sourceId: c.receipt.sourceId, start: 0, end: c.receipt.source.bytes } });
async function proof(c: Context, signal?: AbortSignal) {
  signal?.throwIfAborted(); snapshot(c);
  await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); signal?.throwIfAborted(); snapshot(c);
}
async function indexed(c: Context, facts: CommitRootFacts, budget: WindowBudget, signal?: AbortSignal) {
  for (const part of ['root', 'items', 'terminals'] as const) {
    const range = part === 'root' ? { start: 0, end: c.receipt.source.bytes } : facts[part];
    if (!range) continue;
    const result = await readIndexedCommitContainerPage({ ...c, binding: c.receipt.binding, source: c.receipt.source,
      index: index(c, part, range) }, 0, budget, signal);
    if (result.kind !== 'page' && result.kind !== 'end') return false;
  }
  return true;
}

/** One bounded recovery/build step. Root/array pages precede this checkpoint;
 * the immutable publication precedes any returned projection id. Interrupted
 * jobs reopen by this build id. Rebuild uses a NEW id, preserving old versions.
 * This private structural publication still needs entity/body pages, version
 * ownership and the public renderer adapter before it can enable host ACKs. */
export async function advanceWindowCommitProjection(input: Context, budget: WindowBudget, signal?: AbortSignal) {
  const c = snapshot(input), rootIndex = index(c, 'root'); signal?.throwIfAborted();
  const loaded = await load(c, false, budget);
  let head: Head;
  try {
    if (loaded.kind === 'miss' && loaded.reason !== 'not_found') return rebuild(c);
    head = loaded.kind === 'hit' ? parse(c, loaded.bytes) : { version: 1, sourceId: c.receipt.sourceId, buildId: c.buildId,
      stage: 'root-index', root: createCommitRootState(c.receipt, rootIndex) };
  } catch { return rebuild(c); }
  if (head.stage === 'root-index') {
    const result = await advanceCommitContainerIndex({ ...c, binding: c.receipt.binding, source: c.receipt.source, index: rootIndex }, budget, signal);
    if (result.kind === 'rebuild') return rebuild(c);
    if (result.kind === 'complete') { head.stage = 'root-fields'; head.root = createCommitRootState(c.receipt, rootIndex); }
  } else {
    const root = await advanceCommitRootBatch(c.directory, c.receipt, rootIndex, head.root, budget, signal);
    if (root.kind === 'rebuild' || root.kind === 'pending') return rebuild(c);
    head.root = root.state;
    if (head.stage === 'root-fields') {
      if (root.kind === 'complete') head.stage = 'items-index';
    } else {
      if (root.kind !== 'complete') return rebuild(c);
      if (head.stage === 'publish') {
        const data = bytes(head);
        if (!await indexed(c, root.facts, budget, signal)) return rebuild(c);
        await proof(c, signal);
        try { await writeWindowFrame(c.directory, key(c, true), data); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
          const old = await load(c, true, budget);
          if (old.kind !== 'hit' || !Buffer.from(old.bytes).equals(data)) return rebuild(c);
        }
        await proof(c, signal);
        snapshot(c); signal?.throwIfAborted();
        return { kind: 'complete' as const, projectionId: c.buildId };
      }
      const part = head.stage === 'items-index' ? 'items' : 'terminals', range = root.facts[part];
      if (range) {
        const result = await advanceCommitContainerIndex({ ...c, binding: c.receipt.binding, source: c.receipt.source, index: index(c, part, range) }, budget, signal);
        if (result.kind === 'rebuild') return rebuild(c);
        if (result.kind === 'complete') head.stage = part === 'items' ? 'terminals-index' : 'publish';
      } else head.stage = 'publish';
    }
  }
  await proof(c, signal);
  await writeWindowFrame(c.directory, key(c, false), bytes(head));
  await proof(c, signal);
  snapshot(c); signal?.throwIfAborted();
  return { kind: 'progress' as const, stage: head.stage };
}

/** Point-read a published structural version from its committed source, without
 * touching the canonical data column or substituting the latest row revision. */
export async function readWindowCommitProjection(input: Context, budget: WindowBudget, signal?: AbortSignal) {
  const c = snapshot(input); signal?.throwIfAborted();
  const loaded = await load(c, true, budget);
  let head: Head;
  try { if (loaded.kind !== 'hit') return rebuild(c); head = parse(c, loaded.bytes); if (head.stage !== 'publish') return rebuild(c); }
  catch { return rebuild(c); }
  const root = await advanceCommitRootFields(c.directory, c.receipt, index(c, 'root'), head.root, budget, signal);
  if (root.kind !== 'complete') return rebuild(c);
  if (!await indexed(c, root.facts, budget, signal)) return rebuild(c);
  await proof(c, signal);
  snapshot(c); signal?.throwIfAborted();
  return { kind: 'projection' as const, projectionId: c.buildId, root: root.facts, rootIndex: index(c, 'root'),
    itemsIndex: index(c, 'items', root.facts.items), terminalsIndex: root.facts.terminals ? index(c, 'terminals', root.facts.terminals) : null };
}
