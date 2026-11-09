import type { WindowFrameKey } from '@gugu/session-core/session-record/window-cache/frame';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { readWindowFrame, writeWindowFrame } from './window-commit-projection-disk';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import type { WindowBudget, WindowIoCounters } from '@gugu/session-core/session-record/window-cache/types';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { advanceWindowCommitProjection, readWindowCommitProjection } from './window-commit-projection';
import { advanceCommitContainerIndex, readIndexedCommitContainerPage, type CommitContainerIndex } from './window-commit-container-index';
import { commitChildArray, commitRootArray, openCommitEntity, readCommitEntityPublication } from './window-commit-entity';
import { publishCommitEntity } from './window-commit-entity-publication';
import { assertWindowCommitSource } from './window-commit-source';
import { publishCommitHeader } from './window-commit-header';

type Receipts = Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'>;
type Task = { parent: string | null; entity: 'item' | 'terminal'; page: number; member: number; next: number | null };
type Head = { version: 1; headers?: 1; sourceId: string; buildId: string; stage: 'structure' | 'entities' | 'complete'; count: number; nodes: number; task: Task | null };
export type WindowCommitPublication = { version: 1; sourceId: string; buildId: string; projectionId: string; count: number; nodes: number };
type Row = { version: 1; ordinal: number; entityId: string; parent: string | null };
type Context = { directory: string; receipts: Receipts; receipt: WindowCommitReceipt };
type Ports = { observed?(io: Readonly<WindowIoCounters>): void; phase?(phase: 'projection_durable', publication: WindowCommitPublication): void;
  report?(error: unknown): void };
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
const id = (s: string) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const key = (c: Context, cursor: string, mutable = false) => ({ ...c.receipt.binding, kind: mutable ? 'head' as const : 'projection' as const, cursor: `publisher:${cursor}` });
function committed(c: Context) {
  const stored = c.receipts.bySource(c.receipt.sourceId);
  if (!stored || JSON.stringify(snapshotWindowCommitReceipt(stored)) !== JSON.stringify(c.receipt)) throw new Error('Publisher lost its committed receipt');
}
function snapshot(input: Context): Context {
  const c = { directory: input.directory, receipts: input.receipts, receipt: snapshotWindowCommitReceipt(input.receipt) }; committed(c); return c;
}
function encode(value: unknown) { const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 2048) throw new Error('Publisher metadata exceeds 2 KiB'); return bytes; }
function parse(bytes: Uint8Array): unknown {
  if (bytes.length > 2048) throw new Error('Invalid publisher metadata');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publisher metadata'); return value;
}
function task(value: unknown, nodes: number): Task {
  const t = value as Task;
  if (!t || !(t.parent === null || id(t.parent)) || !['item', 'terminal'].includes(t.entity) || !integer(t.page)
    || !integer(t.member) || t.member > 15 || !(t.next === null || integer(t.next) && t.next < nodes)) throw new Error('Invalid publisher task');
  return { parent: t.parent, entity: t.entity, page: t.page, member: t.member, next: t.next };
}
function head(c: Context, value: unknown): Head {
  const h = value as Head;
  if (!h || h.version !== 1 || h.sourceId !== c.receipt.sourceId || !/^[a-f0-9]{32}$/.test(h.buildId)
    || !['structure', 'entities', 'complete'].includes(h.stage) || !integer(h.count) || h.count > c.receipt.source.bytes
    || !integer(h.nodes) || h.nodes > c.receipt.source.bytes || (h.stage === 'complete' && h.task !== null)) throw new Error('Invalid publisher checkpoint');
  return { version: 1, ...(h.headers === 1 ? { headers: 1 as const } : {}), sourceId: h.sourceId, buildId: h.buildId, stage: h.stage, count: h.count, nodes: h.nodes,
    task: h.task === null ? null : task(h.task, h.nodes) };
}
function publication(c: Context, value: unknown): WindowCommitPublication {
  const p = value as WindowCommitPublication;
  if (!p || p.version !== 1 || p.sourceId !== c.receipt.sourceId || !/^[a-f0-9]{32}$/.test(p.buildId)
    || p.projectionId !== `${p.sourceId}/${p.buildId}` || !integer(p.count) || p.count > c.receipt.source.bytes
    || !integer(p.nodes) || p.nodes > c.receipt.source.bytes) throw new Error('Invalid commit publication');
  return { version: 1, sourceId: p.sourceId, buildId: p.buildId, projectionId: p.projectionId, count: p.count, nodes: p.nodes };
}
async function load(c: Context, cursor: string, budget: WindowBudget, mutable = false) {
  const result = await readWindowFrame(c.directory, key(c, cursor, mutable), budget);
  if (result.kind === 'miss' && result.reason === 'io') throw result.error;
  if (result.kind === 'miss' && result.reason !== 'not_found') throw new Error('Publisher cache needs a new build');
  return result.kind === 'hit' ? parse(result.bytes) : null;
}
async function immutable(c: Context, cursor: string, value: unknown, budget: WindowBudget) {
  const bytes = encode(value);
  try { await writeWindowFrame(c.directory, key(c, cursor), bytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    const previous = await readWindowFrame(c.directory, key(c, cursor), budget);
    if (previous.kind === 'miss' && previous.reason === 'io') throw previous.error;
    if (previous.kind !== 'hit' || !Buffer.from(previous.bytes).equals(bytes)) throw new Error('Conflicting immutable publisher page');
  }
}

/** Background build: a disk linked stack stores arbitrary child depth. Memory
 * holds one task, entity and bounded index page. An entity locator and its
 * continuation nodes precede the checkpoint, so a crash redoes one entity at
 * the same ordinal without keeping a history-sized id set or recursive AST. */
export function createWindowCommitPublisher(directory: string, receipts: Receipts, ports: Ports = {}) {
  const active = new Set<string>();
  const report = (error: unknown) => { try { ports.report?.(error); } catch { /* Diagnostic observer only. */ } };
  async function step<T>(read: (budget: WindowBudget) => Promise<T>) {
    const budget = createWindowBudget(); try { return await read(budget); }
    finally { try { ports.observed?.(budget.counters); } catch (error) { report(error); } }
  }
  async function pop(c: Context, h: Head, next: number | null): Promise<Task | null> {
    if (next === null) return null;
    const loaded = await step(b => load(c, `${h.buildId}:node:${next}`, b));
    return task(loaded, next); // Every immutable link points to an older node.
  }
  async function push(c: Context, h: Head, t: Task): Promise<number> {
    const ordinal = h.nodes;
    await step(b => immutable(c, `${h.buildId}:node:${ordinal}`, task(t, ordinal), b)); h.nodes++;
    return ordinal;
  }
  async function advance(c: Context, h: Head, signal?: AbortSignal) {
    const ctx = { ...c, buildId: h.buildId };
    if (h.stage === 'structure') {
      const built = await step(b => advanceWindowCommitProjection(ctx, b, signal));
      if (built.kind === 'rebuild') throw new Error('Structural projection needs a new build');
      if (built.kind !== 'complete') return;
      const root = await step(b => readWindowCommitProjection(ctx, b, signal)); if (root.kind !== 'projection') throw new Error('Missing durable root');
      await publishCommitHeader({ ...c, index: root.rootIndex, target: 'turn', headerId: h.buildId,
        observed: ports.observed, report }, signal);
      const next = root.terminalsIndex ? await push(c, h, { parent: null, entity: 'terminal', page: 0, member: 0, next: null }) : null;
      h.stage = 'entities'; h.task = { parent: null, entity: 'item', page: 0, member: 0, next }; return;
    }
    const selected = h.task;
    if (!selected) return;
    const root = await step(b => readWindowCommitProjection(ctx, b, signal)); if (root.kind !== 'projection') throw new Error('Missing durable root');
    const parent = selected.parent ? await step(b => readCommitEntityPublication(directory, receipts, c.receipt, selected.parent!, b, signal)) : null;
    if (parent && (parent.kind !== 'entity' || parent.rootBuildId !== h.buildId)) throw new Error('Missing durable parent entity');
    const anchor = parent?.kind === 'entity' ? commitChildArray(parent.facts) : commitRootArray(root.root, selected.entity);
    if (!anchor || parent && selected.entity !== 'item') throw new Error('Invalid publisher parent');
    const index: CommitContainerIndex = { buildId: selected.parent ? hash([h.buildId, selected.parent, 'children'])
      : `${h.buildId}-${selected.entity === 'item' ? 'items' : 'terminals'}`, kind: 'array', range: { ...anchor.range } };
    for (;;) {
      const built = await step(b => advanceCommitContainerIndex({ ...c, binding: c.receipt.binding, source: c.receipt.source, index }, b, signal));
      if (built.kind === 'rebuild') throw new Error('Child array needs a new build'); if (built.kind === 'complete') break;
      await setImmediate(undefined, { signal });
    }
    const page = await step(b => readIndexedCommitContainerPage({ ...c, binding: c.receipt.binding, source: c.receipt.source, index }, selected.page, b, signal));
    if (page.kind === 'end') { h.task = await pop(c, h, selected.next); return; }
    if (page.kind !== 'page' || !page.page.members[selected.member]) throw new Error('Invalid publisher array position');
    const opened = await step(b => openCommitEntity(directory, c.receipt, anchor, index, selected.page, selected.member,
      hash([h.buildId, selected.parent, selected.entity, selected.page, selected.member]), b, signal));
    if (opened.kind !== 'position') throw new Error('Missing actual entity position');
    const built = await publishCommitEntity({ ...c, rootBuildId: h.buildId, position: opened.position, observed: ports.observed, report }, signal);
    if (built.kind !== 'published') throw new Error('Entity publication needs a new build');
    const entity = await step(b => readCommitEntityPublication(directory, receipts, c.receipt, built.entityId, b, signal));
    if (entity.kind !== 'entity') throw new Error('Missing durable entity');
    const row: Row = { version: 1, ordinal: h.count, entityId: built.entityId, parent: selected.parent };
    await step(b => immutable(c, `${h.buildId}:row:${h.count}`, row, b));
    const continuation = selected.member + 1 < page.page.members.length ? { ...selected, member: selected.member + 1 }
      : page.next !== null ? { ...selected, page: page.next, member: 0 } : null;
    if (commitChildArray(entity.facts)) {
      const next = continuation ? await push(c, h, continuation) : selected.next;
      h.task = { parent: built.entityId, entity: 'item', page: 0, member: 0, next };
    } else h.task = continuation ?? await pop(c, h, selected.next);
    h.count++;
  }
  return {
    async publish(input: WindowCommitReceipt, signal?: AbortSignal): Promise<WindowCommitPublication> {
      const c = snapshot({ directory, receipts, receipt: input }); signal?.throwIfAborted();
      if (active.has(c.receipt.sourceId) || active.size >= 32) throw new Error('Commit publisher is occupied');
      active.add(c.receipt.sourceId);
      try {
        const loaded = await step(b => load(c, 'job', b, true));
        const previous = loaded ? head(c, loaded) : null;
        // Older private publications lacked rendering facts. Rebuild under a
        // new immutable build id; never rewrite a previously delivered version.
        const h: Head = previous?.headers === 1 ? previous : { version: 1, headers: 1, sourceId: c.receipt.sourceId, buildId: randomUUID().replaceAll('-', ''),
          stage: 'structure', count: 0, nodes: 0, task: null };
        if (previous !== h) await writeWindowFrame(directory, key(c, 'job', true), encode(h));
        while (h.stage !== 'complete') {
          const previous = encode(h);
          await advance(c, h, signal); signal?.throwIfAborted(); committed(c);
          if (h.stage === 'entities' && !h.task) {
            const p = publication(c, { version: 1, sourceId: h.sourceId, buildId: h.buildId,
              projectionId: `${h.sourceId}/${h.buildId}`, count: h.count, nodes: h.nodes });
            await step(b => immutable(c, `${h.buildId}:publication`, p, b));
            try { ports.phase?.('projection_durable', p); } catch (error) { report(error); }
            h.stage = 'complete';
          }
          const next = encode(h);
          // Structural steps persist their own bounded checkpoint. Rewriting
          // this unchanged outer cursor adds no recovery progress.
          if (!previous.equals(next)) await writeWindowFrame(directory, key(c, 'job', true), next);
          await setImmediate(undefined, { signal });
        }
        const p = publication(c, await step(b => load(c, `${h.buildId}:publication`, b)));
        await assertWindowCommitSource(directory, c.receipt.binding, c.receipt.source); committed(c); signal?.throwIfAborted(); return p;
      } finally { active.delete(c.receipt.sourceId); }
    },
  };
}

/** Resolve the source's durable version by point lookup. A canonical receipt
 * without this publication is needs_location, never an ACKable empty turn. */
export async function readWindowCommitPublication(input: Context, budget: WindowBudget, signal?: AbortSignal,
  beforeRead?: (key: WindowFrameKey) => void) {
  const c = snapshot(input); signal?.throwIfAborted();
  beforeRead?.(key(c, 'job', true));
  const saved = await load(c, 'job', budget, true);
  if (!saved) throw Object.assign(new Error('Commit projection has not been published'), { code: 'needs_location' });
  const h = head(c, saved);
  if (h.stage !== 'complete' || h.headers !== 1) throw Object.assign(new Error('Commit projection is not durable'), { code: 'needs_location' });
  beforeRead?.(key(c, `${h.buildId}:publication`));
  const p = publication(c, await load(c, `${h.buildId}:publication`, budget));
  if (p.count !== h.count || p.nodes !== h.nodes) throw new Error('Commit publication checkpoint mismatch');
  await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); committed(c); signal?.throwIfAborted(); return p;
}

/** Resolve the requested immutable version, including one retained by an older
 * resident. The mutable job head is not a substitute for that version. */
export async function readWindowCommitPublicationVersion(input: Context, projectionId: string, budget: WindowBudget, signal?: AbortSignal) {
  const c = snapshot(input), prefix = `${c.receipt.sourceId}/`, buildId = projectionId.slice(prefix.length);
  if (!projectionId.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(buildId)) throw new Error('Invalid publication version');
  signal?.throwIfAborted();
  const p = publication(c, await load(c, `${buildId}:publication`, budget));
  await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); committed(c); signal?.throwIfAborted();
  return p;
}

/** Point lookup of one already-published entity; caller supplies its actual
 * receipt/version, not a runtime seq or a guessed native fragment alias. */
export async function readPublishedCommitEntity(input: Context, projectionId: string, ordinal: number, budget: WindowBudget, signal?: AbortSignal) {
  const c = snapshot(input), prefix = `${c.receipt.sourceId}/`, buildId = projectionId.slice(prefix.length);
  if (!projectionId.startsWith(prefix) || !/^[a-f0-9]{32}$/.test(buildId) || !integer(ordinal)) throw new Error('Invalid publication position');
  signal?.throwIfAborted();
  const p = publication(c, await load(c, `${buildId}:publication`, budget));
  if (ordinal >= p.count) throw new RangeError('Entity is outside the published turn');
  const row = await load(c, `${buildId}:row:${ordinal}`, budget) as Row;
  if (!row || row.version !== 1 || row.ordinal !== ordinal || !id(row.entityId) || !(row.parent === null || id(row.parent))) throw new Error('Invalid entity locator');
  const entity = await readCommitEntityPublication(c.directory, c.receipts, c.receipt, row.entityId, budget, signal);
  if (entity.kind !== 'entity' || entity.rootBuildId !== buildId) throw new Error('Entity version needs a rebuild');
  await assertWindowCommitSource(c.directory, c.receipt.binding, c.receipt.source); committed(c); signal?.throwIfAborted();
  return { publication: p, ordinal, parent: row.parent, entityId: row.entityId, ...entity };
}
