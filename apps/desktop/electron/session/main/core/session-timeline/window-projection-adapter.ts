import { randomUUID } from 'node:crypto';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import type { WindowLivePosition } from '@gugu/session-wire/session-window-live';
import { snapshotWindowCommitReceipt, type createWindowCommitReceipts, type WindowCommitReceipt } from './window-commit-receipt';
import { readPublishedCommitEntity, readWindowCommitPublicationVersion, type WindowCommitPublication } from './window-commit-publisher';
import { readCommitHeader } from './window-commit-header';
import type { CommitHeader } from './window-commit-header-fields';
import { assertWindowCommitSource } from './window-commit-source';
import { createWindowProjectionHandles } from './window-projection-handles';
import { readProjectionField, type ProjectionFieldPosition } from './window-projection-field';

type Owner = object;
type Release = (budget: WindowBudget, signal?: AbortSignal) => Promise<void>;
type Ports = {
  directory: string; receipts: Pick<ReturnType<typeof createWindowCommitReceipts>, 'bySource'>;
  /** Real sender/subscription/session authority, checked again after last await. */
  authorize(owner: Owner, position: Readonly<WindowLivePosition>): WindowCommitReceipt;
  assertOwner(owner: Owner, receipt: Readonly<WindowCommitReceipt>): void;
  /** Must acquire the actual durable version pin. No default/no-op pin. */
  acquire(owner: Owner, version: { receipt: WindowCommitReceipt; projectionId: string }, budget: WindowBudget, signal?: AbortSignal): Promise<Release>;
  releaseOwner(owner: Owner, budget: WindowBudget, signal?: AbortSignal): Promise<{ complete: boolean }>;
  report?(error: unknown): void;
};
type Lease = { owner: Owner; id: string; receipt: WindowCommitReceipt; position: WindowLivePosition;
  pinOwner: Owner; publication?: WindowCommitPublication; release?: Release; closing: boolean; abort: AbortController; busy: boolean };
type PageHandle = { type: 'page'; lease: string; ordinal: number };
type FieldHandle = { type: 'field'; lease: string; position: ProjectionFieldPosition };

/** Host-side ports only; A freezes their public DTO before controller wiring.
 * Opening a version is independent of live insert/update semantics, so Older
 * does not manufacture a first-commit proof for a historical row. */
export function createWindowProjectionAdapter(ports: Ports) {
  const leases = new Map<string, Lease>(), handles = createWindowProjectionHandles();
  let pending = 0;
  const failure = (message: string, code = 'needs_location') => Object.assign(new Error(message), { code });
  function proof(lease: Lease) {
    ports.assertOwner(lease.owner, lease.receipt); lease.abort.signal.throwIfAborted();
    const stored = ports.receipts.bySource(lease.receipt.sourceId);
    if (!stored || JSON.stringify(snapshotWindowCommitReceipt(stored)) !== JSON.stringify(lease.receipt)) throw failure('Projection receipt no longer exists');
  }
  function selected(owner: Owner, id: string) {
    const lease = leases.get(id);
    if (!lease || lease.owner !== owner || lease.closing) throw failure('Projection owner is closed', 'closed');
    proof(lease); return lease;
  }
  function field(lease: Lease, position: ProjectionFieldPosition) {
    return handles.seal({ type: 'field', lease: lease.id, position } satisfies FieldHandle);
  }
  function header(lease: Lease, input: CommitHeader) {
    return { target: input.target, values: { ...input.values }, fields: input.deferred.map(value => ({
      field: value.field, kind: value.kind, handle: field(lease, { kind: value.kind, range: { ...value.range } }),
    })) };
  }
  async function operation<T>(lease: Lease, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>) {
    proof(lease); signal?.throwIfAborted();
    if (lease.busy || pending >= 16) throw failure('Projection read is occupied', 'capacity');
    lease.busy = true; pending++;
    const controller = new AbortController();
    const abort = () => controller.abort(lease.abort.signal.aborted ? lease.abort.signal.reason : signal?.reason);
    lease.abort.signal.addEventListener('abort', abort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await run(controller.signal);
      // This synchronous final check is outside async helpers' return gap.
      proof(lease); signal?.throwIfAborted(); return result;
    } finally {
      lease.abort.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort);
      lease.busy = false; pending--;
    }
  }
  return {
    async open(owner: Owner, input: WindowLivePosition, budget: WindowBudget, signal?: AbortSignal) {
      // Snapshot the scalar locator before any await. Superseded revisions use
      // their own receipt and are never silently replaced with latest-by-row.
      const position: WindowLivePosition = { referenceId: input.referenceId, projectionId: input.projectionId, rowId: input.rowId, storedSeq: input.storedSeq };
      const receipt = snapshotWindowCommitReceipt(ports.authorize(owner, position));
      if (receipt.referenceId !== position.referenceId || receipt.rowId !== position.rowId || receipt.storedSeq !== position.storedSeq
        || !position.projectionId.startsWith(`${receipt.sourceId}/`)) throw failure('Projection locator does not match its receipt');
      signal?.throwIfAborted();
      if (leases.size >= 64) throw failure('Resident projection versions must be released', 'capacity');
      const lease: Lease = { owner, pinOwner: {}, id: randomUUID(), receipt, position, closing: false, abort: new AbortController(), busy: false };
      leases.set(lease.id, lease);
      try {
        const output = await operation(lease, signal, async combined => {
          lease.release = await ports.acquire(lease.pinOwner, { receipt: snapshotWindowCommitReceipt(receipt), projectionId: position.projectionId }, budget, combined);
          proof(lease); combined.throwIfAborted();
          const context = { directory: ports.directory, receipts: ports.receipts, receipt };
          const publication = await readWindowCommitPublicationVersion(context, position.projectionId, budget, combined);
          if (publication.projectionId !== position.projectionId) throw failure('Requested immutable projection is unavailable');
          const root = await readCommitHeader({ ...context, target: 'turn', range: { start: 0, end: receipt.source.bytes } }, publication.buildId, budget, combined);
          if (root.values.referenceId !== receipt.referenceId || root.values.seq !== receipt.storedSeq) throw failure('Root header identity differs');
          lease.publication = publication;
          const result = { lease: lease.id, position: { ...position }, root: header(lease, root), count: publication.count,
            next: publication.count ? handles.seal({ type: 'page', lease: lease.id, ordinal: 0 } satisfies PageHandle) : null };
          budget.charge('outputBytes', Buffer.byteLength(JSON.stringify(result))); return result;
        });
        proof(lease); signal?.throwIfAborted(); return output;
      } catch (error) {
        lease.closing = true; lease.abort.abort(error);
        // Retain failed cleanup as an owner-owned bounded lease. close(owner)
        // retries its durable release; dropping it would hide a live pin.
        try {
          if (lease.release) { await lease.release(budget); leases.delete(lease.id); }
          else if ((await ports.releaseOwner(lease.pinOwner, budget)).complete) leases.delete(lease.id);
        } catch (cleanupError) { try { ports.report?.(cleanupError); } catch { /* close retries durable cleanup */ } }
        throw error;
      }
    },
    async readPage(owner: Owner, token: string, budget: WindowBudget, signal?: AbortSignal) {
      const cursor = handles.open(token) as PageHandle;
      if (!cursor || cursor.type !== 'page' || !Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 0) throw failure('Invalid projection page cursor');
      const lease = selected(owner, cursor.lease);
      const result = await operation(lease, signal, async combined => {
        const context = { directory: ports.directory, receipts: ports.receipts, receipt: lease.receipt };
        const row = await readPublishedCommitEntity(context, lease.position.projectionId, cursor.ordinal, budget, combined);
        if (!lease.publication || row.publication.count !== lease.publication.count) throw failure('Projection publication changed');
        const facts = await readCommitHeader({ ...context, target: row.position.entity, range: row.position.range }, row.entityId, budget, combined);
        if (facts.values[row.position.entity === 'terminal' ? 'terminalId' : 'id'] !== row.facts.id
          || row.position.entity === 'item' && facts.values.kind !== row.facts.kind) throw failure('Entity header identity differs');
        const output = { lease: lease.id, position: { ...lease.position }, ordinal: row.ordinal, entityId: row.entityId, parentEntityId: row.parent,
          header: header(lease, facts), hasChildren: !!row.facts.children, bodies: row.facts.slots.map(slot => ({ field: slot.field,
            handle: field(lease, { kind: 'string', range: { ...slot.range } }) })),
          next: cursor.ordinal + 1 < row.publication.count ? handles.seal({ type: 'page', lease: lease.id, ordinal: cursor.ordinal + 1 } satisfies PageHandle) : null };
        budget.charge('outputBytes', Buffer.byteLength(JSON.stringify(output))); return output;
      });
      proof(lease); signal?.throwIfAborted(); return result;
    },
    async readField(owner: Owner, token: string, budget: WindowBudget, signal?: AbortSignal) {
      const value = handles.open(token) as FieldHandle;
      if (!value || value.type !== 'field') throw failure('Invalid projection field handle');
      const lease = selected(owner, value.lease);
      const result = await operation(lease, signal, async combined => {
        const page = await readProjectionField(ports.directory, lease.receipt, value.position, budget, combined);
        const output = page.kind === 'body' ? { kind: 'body' as const, text: page.text, offset: page.offset,
          next: page.complete ? null : field(lease, page.next) }
          : { kind: 'values' as const, containerKind: page.containerKind, entries: page.members.map(member => ({ ordinal: member.ordinal,
            key: member.key ? field(lease, member.key) : null,
            value: member.value.kind === 'scalar' ? member.value : { kind: 'field' as const, fieldKind: member.value.position.kind,
              handle: field(lease, member.value.position) } })),
          next: page.complete ? null : field(lease, page.next) };
        if (page.kind === 'values') budget.charge('outputBytes', Buffer.byteLength(JSON.stringify(output)));
        await assertWindowCommitSource(ports.directory, lease.receipt.binding, lease.receipt.source);
        return output;
      });
      proof(lease); signal?.throwIfAborted(); return result;
    },
    async release(owner: Owner, id: string, budget: WindowBudget, signal?: AbortSignal) {
      const lease = leases.get(id);
      if (!lease) return;
      if (lease.owner !== owner) throw failure('Projection owner differs', 'closed');
      lease.closing = true; lease.abort.abort(new DOMException('Projection released', 'AbortError'));
      if (lease.busy) throw failure('Projection cleanup is waiting for its read', 'pending');
      if (lease.release) await lease.release(budget, signal);
      else if (!(await ports.releaseOwner(lease.pinOwner, budget, signal)).complete) return;
      leases.delete(id);
    },
    /** One version per call; the host repeats with a new budget until complete.
     * Closing prevents new reads immediately, while capacity stays held until
     * every in-flight read and durable pin release actually settles. */
    async close(owner: Owner, budget: WindowBudget, signal?: AbortSignal) {
      const owned = [...leases.values()].filter(lease => lease.owner === owner);
      for (const lease of owned) { lease.closing = true; lease.abort.abort(new DOMException('Projection owner closed', 'AbortError')); }
      const lease = owned[0];
      if (!lease) return { complete: true };
      if (lease.busy) return { complete: false };
      if (lease.release) await lease.release(budget, signal);
      else if (!(await ports.releaseOwner(lease.pinOwner, budget, signal)).complete) return { complete: false };
      leases.delete(lease.id); return { complete: owned.length === 1 };
    },
  };
}
